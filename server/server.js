const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const createUploadRouter = require("./routes/upload");
const { attachSocketHandlers } = require("./sockets");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3002;
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(__dirname, process.env.UPLOAD_DIR)
  : path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const rooms = new Map();

// Diagnostic startup logs to help Render troubleshooting
try {
  console.log("[backend] server file:", __filename);
  console.log("[backend] cwd:", process.cwd());
  console.log("[backend] NODE_ENV:", process.env.NODE_ENV);
  console.log("[backend] PORT env:", process.env.PORT);
  console.log("[backend] server.js exists:", fs.existsSync(__filename));
} catch (err) {
  console.error("[backend] startup diagnostic failed", err);
}

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

console.log("Registering /health route");

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Server is running"
  });
});

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.use("/upload", createUploadRouter({ uploadDir: UPLOAD_DIR, rooms }));
// Serve video files with explicit range support (partial content)
const CONTENT_TYPE_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg'
};

app.get('/video/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';

    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
        return res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });

      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('[video] serve error', err);
    res.status(500).end();
  }
});

// Subs and HLS streams can be served statically
const staticOptions = {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
  }
};

app.use('/video', express.static(UPLOAD_DIR, staticOptions));
app.use('/subs', express.static(UPLOAD_DIR, staticOptions));
// expose HLS output under /streams
app.use('/streams', express.static(UPLOAD_DIR, staticOptions));

attachSocketHandlers(io, rooms, { uploadDir: UPLOAD_DIR });

console.log(`[backend] startup on port ${PORT}`);
console.log(`[backend] upload dir ${UPLOAD_DIR}`);

const maxPortAttempts = 20;

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.unref();
    tester.once("error", () => {
      resolve(false);
    });
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, "0.0.0.0");
  });
}

async function findAvailablePort(startPort, attempts = maxPortAttempts) {
  for (let offset = 0; offset <= attempts; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const available = await canListenOnPort(candidate);
    if (available) {
      if (offset > 0) {
        console.warn(`[backend] port ${startPort} is busy, selected ${candidate}`);
      }
      return candidate;
    }
  }

  throw new Error(`No free port found after ${attempts + 1} attempts starting from ${startPort}`);
}

function startServer(port) {
  server.listen(port, () => {
    console.log(`Server running on ${port}`);
  });
}

(async () => {
  const chosenPort = await findAvailablePort(Number(PORT), maxPortAttempts);
  startServer(chosenPort);
})().catch((error) => {
  console.error("[backend] failed to start server", error);
  process.exit(1);
});
