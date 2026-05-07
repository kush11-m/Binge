const path = require("path");
const fs = require("fs");
const multer = require("multer");
const express = require("express");
const { nanoid } = require("nanoid");

const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const SUB_TYPES = new Set(["text/vtt", "application/x-subrip"]);

function srtToVtt(srtContent) {
  const normalized = srtContent.replace(/\uFEFF/g, "").replace(/\r+/g, "").trim();
  const withDots = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${withDots}\n`;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

function createUploadRouter({ uploadDir, rooms }) {
  const router = express.Router();

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
    }
  });

  const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
      if (file.fieldname === "video" && VIDEO_TYPES.has(file.mimetype)) return cb(null, true);
      if (file.fieldname === "subs" && (SUB_TYPES.has(file.mimetype) || file.originalname.endsWith(".srt"))) {
        return cb(null, true);
      }
      cb(new Error("Unsupported file type"));
    }
  });

  router.post(
    "/",
    upload.fields([
      { name: "video", maxCount: 1 },
      { name: "subs", maxCount: 1 }
    ]),
    (req, res) => {
      const roomId = (req.body.roomId || "").trim();
      const videoFile = req.files && req.files.video ? req.files.video[0] : null;
      const subsFile = req.files && req.files.subs ? req.files.subs[0] : null;

      if (!roomId) {
        return res.status(400).json({ error: "roomId is required" });
      }

      if (!videoFile) {
        return res.status(400).json({ error: "video file is required" });
      }

      const room = rooms.get(roomId) || {
        state: { currentTime: 0, isPlaying: false },
        updatedAt: Date.now(),
        files: {},
        users: new Set(),
        cleanupTimer: null,
        expiryTimer: null
      };

      if (room.files.video) {
        safeUnlink(path.join(uploadDir, path.basename(room.files.video)));
      }
      if (room.files.subs) {
        safeUnlink(path.join(uploadDir, path.basename(room.files.subs)));
      }

      room.files.video = `/video/${videoFile.filename}`;

      if (subsFile) {
        const subsExt = path.extname(subsFile.originalname || "").toLowerCase();
        if (subsExt === ".srt") {
          const originalPath = path.join(uploadDir, subsFile.filename);
          const nextName = `${path.basename(subsFile.filename, subsExt)}.vtt`;
          const nextPath = path.join(uploadDir, nextName);
          try {
            const srtContent = fs.readFileSync(originalPath, "utf8");
            fs.writeFileSync(nextPath, srtToVtt(srtContent), "utf8");
            fs.unlinkSync(originalPath);
            room.files.subs = `/subs/${nextName}`;
          } catch (error) {
            safeUnlink(originalPath);
            return res.status(500).json({ error: "Subtitle conversion failed" });
          }
        } else {
          room.files.subs = `/subs/${subsFile.filename}`;
        }
      } else {
        room.files.subs = null;
      }

      rooms.set(roomId, room);

      return res.json({
        roomId,
        videoUrl: room.files.video,
        subsUrl: room.files.subs
      });
    }
  );

  return router;
}

module.exports = createUploadRouter;
