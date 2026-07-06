const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { computeState, getOrCreateRoom, normalizeRoomId, safeUnlink } = require("../rooms");

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".ogg"]);
const SUB_EXTS = new Set([".srt", ".vtt"]);

function srtToVtt(input) {
  const normalized = input.replace(/\uFEFF/g, "").replace(/\r+/g, "").trim();
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}\n`;
}

function createUploadRouter({ uploadDir, rooms, io, env = process.env }) {
  const router = express.Router();
  const roomOptions = {
    uploadDir,
    ttlMs: Number(env.ROOM_TTL_MS || 2 * 60 * 60 * 1000)
  };

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => {
        const token = crypto.randomBytes(5).toString("hex");
        cb(null, `${Date.now()}-${token}${path.extname(file.originalname || "").toLowerCase()}`);
      }
    }),
    limits: {
      fileSize: Number(env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024 * 1024)
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (file.fieldname === "video" && VIDEO_EXTS.has(ext) && file.mimetype.startsWith("video/")) {
        cb(null, true);
        return;
      }
      if (file.fieldname === "subs" && SUB_EXTS.has(ext)) {
        cb(null, true);
        return;
      }
      cb(new Error(`Unsupported ${file.fieldname || "file"} type`));
    }
  });

  router.post("/", (req, res) => {
    upload.fields([{ name: "video", maxCount: 1 }, { name: "subs", maxCount: 1 }])(req, res, (error) => {
      if (error) {
        res.status(400).json({ error: error.message || "Upload failed" });
        return;
      }

      const roomId = normalizeRoomId(req.body.roomId);
      const mode = req.body.mode === "INTERNET" ? "INTERNET" : "LAN";
      const videoFile = req.files?.video?.[0];
      const subsFile = req.files?.subs?.[0];

      if (!roomId || !videoFile) {
        if (videoFile) safeUnlink(videoFile.path);
        if (subsFile) safeUnlink(subsFile.path);
        res.status(400).json({ error: "roomId and video are required" });
        return;
      }

      const room = getOrCreateRoom(rooms, roomId, mode, roomOptions);
      room.mode = mode || room.mode || "LAN";
      ["video", "subs"].forEach((key) => {
        if (room.files?.[key]) safeUnlink(path.join(uploadDir, path.basename(room.files[key])));
      });

      room.files.video = `/video/${videoFile.filename}`;
      room.files.hls = null;

      if (subsFile) {
        const ext = path.extname(subsFile.originalname || "").toLowerCase();
        if (ext === ".srt") {
          const nextName = `${path.basename(subsFile.filename, path.extname(subsFile.filename))}.vtt`;
          const nextPath = path.join(uploadDir, nextName);
          try {
            fs.writeFileSync(nextPath, srtToVtt(fs.readFileSync(subsFile.path, "utf8")), "utf8");
            safeUnlink(subsFile.path);
            room.files.subs = `/subs/${nextName}`;
          } catch (conversionError) {
            safeUnlink(subsFile.path);
            res.status(500).json({ error: "Subtitle conversion failed" });
            return;
          }
        } else {
          room.files.subs = `/subs/${subsFile.filename}`;
        }
      } else {
        room.files.subs = null;
      }

      room.state = { currentTime: 0, isPlaying: false };
      room.updatedAt = Date.now();
      rooms.set(roomId, room);

      if (io) {
        io.to(roomId).emit("state", computeState(room));
        io.to(roomId).emit("presence", { viewers: room.users?.size || 0, hostId: room.hostId || null });
      }

      res.json({
        roomId,
        mode: room.mode,
        videoUrl: room.files.video,
        subsUrl: room.files.subs,
        hlsUrl: room.files.hls
      });
    });
  });

  router.post("/p2p", (req, res) => {
    const roomId = normalizeRoomId(req.body.roomId);
    const videoName = String(req.body.videoName || "Local video").trim().slice(0, 180);
    const mode = "INTERNET";

    if (!roomId) {
      res.status(400).json({ error: "roomId is required" });
      return;
    }

    const room = getOrCreateRoom(rooms, roomId, mode, roomOptions);
    room.mode = mode;
    ["video", "subs"].forEach((key) => {
      if (room.files?.[key]) safeUnlink(path.join(uploadDir, path.basename(room.files[key])));
    });

    room.files.video = `p2p://host/${encodeURIComponent(videoName || "local-video")}`;
    room.files.hls = null;

    const subsText = typeof req.body.subsText === "string" ? req.body.subsText : "";
    const subsName = String(req.body.subsName || "").trim();
    if (subsText && subsText.length <= Number(env.MAX_SUBTITLE_TEXT_BYTES || 2 * 1024 * 1024)) {
      const originalExt = path.extname(subsName).toLowerCase();
      const token = crypto.randomBytes(5).toString("hex");
      const nextName = `${Date.now()}-${token}.vtt`;
      const nextPath = path.join(uploadDir, nextName);
      const vttText = originalExt === ".srt" ? srtToVtt(subsText) : subsText;
      fs.writeFileSync(nextPath, vttText.startsWith("WEBVTT") ? vttText : `WEBVTT\n\n${vttText}`, "utf8");
      room.files.subs = `/subs/${nextName}`;
    } else {
      room.files.subs = null;
    }

    room.state = { currentTime: 0, isPlaying: false };
    room.updatedAt = Date.now();
    rooms.set(roomId, room);

    if (io) {
      io.to(roomId).emit("state", computeState(room));
      io.to(roomId).emit("presence", { viewers: room.users?.size || 0, hostId: room.hostId || null });
    }

    res.json({
      roomId,
      mode: room.mode,
      videoUrl: room.files.video,
      subsUrl: room.files.subs,
      hlsUrl: room.files.hls
    });
  });

  return router;
}

module.exports = createUploadRouter;
