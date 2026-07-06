const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const createUploadRouter = require("./routes/upload");
const { attachSocketHandlers } = require("./sockets");
const { assessInternetReadiness } = require("./internet-readiness");
const { getNetworkUrls } = require("./network");

const CONTENT_TYPE_BY_EXT = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".ogg": "video/ogg",
  ".vtt": "text/vtt"
};
const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".ogg"];
const SUPPORTED_SUBTITLE_EXTENSIONS = [".srt", ".vtt"];
const PLACEHOLDER_VALUES = new Set([
  "",
  "change-me",
  "changeme",
  "your-user",
  "your-password",
  "user",
  "pass",
  "turn.example.com"
]);

function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUES.has(String(value || "").trim().toLowerCase());
}

function isRealTurnServer(server = {}) {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const hasTurnUrl = urls.some((url) => {
    if (typeof url !== "string" || !url.startsWith("turn")) return false;
    return !url.includes("turn.example.com");
  });

  if (!hasTurnUrl) return false;
  return !isPlaceholderValue(server.username) && !isPlaceholderValue(server.credential);
}

function hasTurnConfig(env = process.env) {
  if (env.NEXT_PUBLIC_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.NEXT_PUBLIC_ICE_SERVERS);
      return Array.isArray(parsed) && parsed.some(isRealTurnServer);
    } catch (_error) {
      return false;
    }
  }

  const turnUrl = String(env.NEXT_PUBLIC_TURN_URL || "").trim();
  if (!turnUrl.startsWith("turn") || turnUrl.includes("turn.example.com")) return false;
  return !isPlaceholderValue(env.NEXT_PUBLIC_TURN_USERNAME)
    && !isPlaceholderValue(env.NEXT_PUBLIC_TURN_CREDENTIAL);
}

function createBingeServer(options = {}) {
  const env = options.env || process.env;
  const app = express();
  const httpServer = http.createServer(app);
  const rooms = options.rooms || new Map();
  const uploadDir = options.uploadDir
    ? path.resolve(options.uploadDir)
    : env.UPLOAD_DIR
      ? path.resolve(__dirname, env.UPLOAD_DIR)
      : path.join(__dirname, "uploads");

  fs.mkdirSync(uploadDir, { recursive: true });

  const corsOrigin = env.CORS_ORIGIN || "*";
  const corsConfig = {
    origin: corsOrigin === "*" ? "*" : corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean),
    methods: ["GET", "POST", "OPTIONS"]
  };

  const io = new Server(httpServer, {
    cors: corsConfig,
    maxHttpBufferSize: Number(env.SOCKET_MAX_HTTP_BUFFER_SIZE || 1e8)
  });

  app.use(cors(corsConfig));
  app.use(express.json({ limit: env.JSON_LIMIT || "2mb" }));

  const socketDiagnostics = attachSocketHandlers(io, rooms, { uploadDir });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      rooms: rooms.size,
      turnConfigured: hasTurnConfig(env)
    });
  });

  app.get("/ready", (_req, res) => {
    fs.access(uploadDir, fs.constants.W_OK, (error) => {
      if (error) {
        res.status(503).json({ status: "error", uploadDirWritable: false });
        return;
      }

      res.json({ status: "ready", uploadDirWritable: true });
    });
  });

  app.get("/diagnostics", (_req, res) => {
    res.json({
      status: "ok",
      activeRooms: rooms.size,
      activeCallRooms: socketDiagnostics.getCallRoomCount(),
      maxRoomUsers: Number(env.MAX_ROOM_USERS || 8),
      maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024 * 1024),
      supportedVideoExtensions: SUPPORTED_VIDEO_EXTENSIONS,
      supportedSubtitleExtensions: SUPPORTED_SUBTITLE_EXTENSIONS,
      uploadDirWritable: true,
      supportsP2pPrepare: true,
      turnConfigured: hasTurnConfig(env),
      corsOrigin: corsOrigin === "*" ? "all" : "restricted"
    });
  });

  app.get("/capabilities", (_req, res) => {
    res.json({
      status: "ok",
      apiVersion: 2,
      p2pPrepare: true,
      lanUpload: true,
      diagnostics: true
    });
  });

  app.get("/network", (_req, res) => {
    const port = Number(env.PUBLIC_PORT || env.PORT || 3002);
    const protocol = env.PUBLIC_PROTOCOL || "http";
    const candidates = getNetworkUrls({ port, protocol });
    res.json({
      status: "ok",
      candidates,
      primaryUrl: candidates[0]?.url || null
    });
  });

  app.get("/internet-readiness", (req, res) => {
    res.json(assessInternetReadiness({
      env,
      requestHost: req.get("host") || "",
      forwardedProto: req.get("x-forwarded-proto") || "",
      secure: req.secure,
      turnConfigured: hasTurnConfig(env),
      corsOrigin
    }));
  });

  app.get("/", (_req, res) => {
    res.type("text").send("Binge sync server is running");
  });

  app.use("/upload", createUploadRouter({ uploadDir, rooms, io, env }));

  function streamFile(req, res, filePath) {
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);

    if (!range) {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const [startRaw, endRaw] = range.replace("bytes=", "").split("-");
    const start = Number.parseInt(startRaw, 10);
    const end = endRaw ? Number.parseInt(endRaw, 10) : fileSize - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  app.get("/video/:filename", (req, res) => {
    streamFile(req, res, path.join(uploadDir, path.basename(req.params.filename)));
  });

  app.get("/subs/:filename", (req, res) => {
    streamFile(req, res, path.join(uploadDir, path.basename(req.params.filename)));
  });

  app.use("/streams", express.static(uploadDir, {
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Cache-Control", "no-store");
    }
  }));

  return { app, httpServer, io, rooms, uploadDir };
}

function startServer(options = {}) {
  const env = options.env || process.env;
  const port = Number(options.port || env.PORT || 3002);
  const host = options.host || env.HOST || "0.0.0.0";
  const serverContext = createBingeServer(options);

  serverContext.httpServer.listen(port, host, () => {
    const address = serverContext.httpServer.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    console.log(`[binge] sync server listening on ${boundPort}`);
    console.log(`[binge] uploads at ${serverContext.uploadDir}`);
  });

  return serverContext;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createBingeServer,
  startServer,
  hasTurnConfig,
  assessInternetReadiness,
  getNetworkUrls
};
