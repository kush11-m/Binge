const fs = require("fs");
const path = require("path");

const MAX_USERS = 4;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const EMPTY_ROOM_GRACE_MS = 2 * 60 * 1000;

function attachSocketHandlers(io, rooms, { uploadDir }) {
  function getOrCreateRoom(roomId) {
    const existing = rooms.get(roomId);
    if (existing) return existing;

    const room = {
      state: { currentTime: 0, isPlaying: false },
      updatedAt: Date.now(),
      files: { video: null, subs: null },
      users: new Set(),
      cleanupTimer: null,
      expiryTimer: null
    };

    room.expiryTimer = setTimeout(() => {
      cleanupRoom(roomId);
    }, ROOM_TTL_MS);

    rooms.set(roomId, room);
    return room;
  }

  function cleanupRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    if (room.expiryTimer) clearTimeout(room.expiryTimer);

    const files = Object.values(room.files || {});
    files.forEach((fileUrl) => {
      if (!fileUrl) return;
      const filePath = path.join(uploadDir, path.basename(fileUrl));
      fs.unlink(filePath, () => {});
    });

    rooms.delete(roomId);
  }

  function computeState(room) {
    const now = Date.now();
    let currentTime = room.state.currentTime || 0;
    if (room.state.isPlaying) {
      currentTime += (now - room.updatedAt) / 1000;
    }
    return {
      currentTime,
      isPlaying: room.state.isPlaying,
      serverTime: now,
      videoUrl: room.files.video || null,
      subsUrl: room.files.subs || null
    };
  }

  function updateState(room, payload) {
    const now = Date.now();
    room.state = {
      currentTime: Number.isFinite(payload.currentTime) ? payload.currentTime : room.state.currentTime,
      isPlaying: typeof payload.isPlaying === "boolean" ? payload.isPlaying : room.state.isPlaying
    };
    room.updatedAt = now;
  }

  io.on("connection", (socket) => {
    socket.on("join-room", ({ roomId }) => {
      if (!roomId) return;

      const room = getOrCreateRoom(roomId);
      if (room.users.size >= MAX_USERS) {
        socket.emit("room-full");
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      room.users.add(socket.id);

      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      socket.emit("state", computeState(room));
    });

    socket.on("state", ({ roomId, currentTime, isPlaying }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      updateState(room, { currentTime, isPlaying });
      socket.to(roomId).emit("state", computeState(room));
    });

    socket.on("sync-request", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      socket.emit("state", computeState(room));
    });

    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      room.users.delete(socket.id);
      if (room.users.size === 0) {
        room.cleanupTimer = setTimeout(() => cleanupRoom(roomId), EMPTY_ROOM_GRACE_MS);
      }
    });
  });
}

module.exports = { attachSocketHandlers };
