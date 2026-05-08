const path = require("path");
const fs = require("fs");
const http = require("http");
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

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/upload", createUploadRouter({ uploadDir: UPLOAD_DIR, rooms }));

const staticOptions = {
  acceptRanges: true,
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
  }
};

app.use("/video", express.static(UPLOAD_DIR, staticOptions));
app.use("/subs", express.static(UPLOAD_DIR, staticOptions));

attachSocketHandlers(io, rooms, { uploadDir: UPLOAD_DIR });

console.log(`[backend] startup on port ${PORT}`);
console.log(`[backend] upload dir ${UPLOAD_DIR}`);

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
