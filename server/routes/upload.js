const path = require("path");
const fs = require("fs");
const multer = require("multer");
const express = require("express");
const { nanoid } = require("nanoid");

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/ogg"]);
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
      try {
        const name = (file.originalname || "").toLowerCase();
        const ext = path.extname(name);

        if (file.fieldname === "video") {
          const allowedExts = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".ogg"]);
          if ((file.mimetype && file.mimetype.startsWith("video/")) || allowedExts.has(ext)) return cb(null, true);
          return cb(new Error("Unsupported video file type"));
        }

        if (file.fieldname === "subs") {
          if (SUB_TYPES.has(file.mimetype) || name.endsWith(".srt") || name.endsWith(".vtt")) return cb(null, true);
          return cb(new Error("Unsupported subtitle file type"));
        }

        return cb(null, false);
      } catch (err) {
        return cb(err);
      }
    }
  });

  router.post("/", (req, res) => {
    upload.fields([
      { name: "video", maxCount: 1 },
      { name: "subs", maxCount: 1 }
    ])(req, res, (err) => {
      if (err) {
        console.warn("[upload] multer error", err && err.message);
        return res.status(400).json({ error: err && err.message ? err.message : "Upload failed" });
      }

      const roomId = (req.body.roomId || "").trim();
      const videoFile = req.files && req.files.video ? req.files.video[0] : null;
      const subsFile = req.files && req.files.subs ? req.files.subs[0] : null;

      console.log("[upload] request received", {
        roomId,
        hasVideo: Boolean(videoFile),
        hasSubs: Boolean(subsFile)
      });

      if (!roomId) {
        console.warn("[upload] rejected: roomId is required");
        return res.status(400).json({ error: "roomId is required" });
      }

      if (!videoFile) {
        console.warn("[upload] rejected: video file is required");
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

      // Start asynchronous HLS generation using ffmpeg (if available)
      try {
        const originalPath = path.join(uploadDir, videoFile.filename);
        const baseName = path.basename(videoFile.filename, path.extname(videoFile.filename));
        const hlsDirName = `${baseName}-hls`;
        const hlsDir = path.join(uploadDir, hlsDirName);
        if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });

        const hlsIndex = path.join(hlsDir, 'index.m3u8');

        const { spawn, spawnSync } = require('child_process');

        // locate ffmpeg: respect FFMPEG_PATH env var, otherwise try `which ffmpeg`
        let ffmpegPath = process.env.FFMPEG_PATH || null;
        if (!ffmpegPath) {
          try {
            const which = spawnSync('which', ['ffmpeg']);
            if (which && which.status === 0) ffmpegPath = which.stdout.toString().trim();
          } catch (e) {
            ffmpegPath = null;
          }
        }

        if (!ffmpegPath) {
          console.warn('[upload] ffmpeg not found on PATH; skipping HLS generation');
        } else {
          const ffmpegArgs = [
            '-i', originalPath,
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-preset', 'veryfast',
            '-crf', '28',
            '-hls_time', '4',
            '-hls_playlist_type', 'vod',
            '-hls_segment_filename', path.join(hlsDir, 'segment%03d.ts'),
            hlsIndex
          ];

          const ff = spawn(ffmpegPath, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
          ff.on('error', (err) => {
            console.warn('[upload] ffmpeg process error', err && err.message);
          });
          ff.stdout.on('data', (d) => console.log('[ffmpeg]', d.toString().trim()));
          ff.stderr.on('data', (d) => console.log('[ffmpeg]', d.toString().trim()));
          ff.on('exit', (code, sig) => {
            if (code === 0) {
              console.log(`[upload] HLS created at /streams/${hlsDirName}/index.m3u8`);
              // update room with HLS path if still present
              const r = rooms.get(roomId);
              if (r) {
                r.files.hls = `/streams/${hlsDirName}/index.m3u8`;
                rooms.set(roomId, r);
              }
            } else {
              console.warn('[upload] ffmpeg exited with', code, sig);
            }
          });
        }
      } catch (err) {
        console.warn('[upload] ffmpeg spawn failed', err && err.message);
      }

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
            console.error("[upload] subtitle conversion failed", error);
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
      console.log("[upload] upload completed", {
        roomId,
        videoUrl: room.files.video,
        subsUrl: room.files.subs
      });

      return res.json({
        roomId,
        videoUrl: room.files.video,
        subsUrl: room.files.subs
      });
    });
  });

  return router;
}

module.exports = createUploadRouter;
