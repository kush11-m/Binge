const fs = require("fs");
const path = require("path");

const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const ROOM_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/i;

function setRoomTimer(callback, timeoutMs) {
  const timer = setTimeout(callback, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function safeUnlink(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

function normalizeRoomId(roomId) {
  const normalized = String(roomId || "").trim().slice(0, 64);
  return ROOM_ID_PATTERN.test(normalized) ? normalized.toUpperCase() : "";
}

function normalizeRoom(room, roomId, mode = "LAN") {
  room.state ||= { currentTime: 0, isPlaying: false };
  room.updatedAt ||= Date.now();
  room.files ||= { video: null, subs: null, hls: null };
  room.users ||= new Set();
  room.mode ||= mode;
  room.hostId ||= null;
  room.cleanupTimer ||= null;
  room.cleanupCallbacks ||= new Set();
  return room;
}

function cleanupRoom(rooms, roomId, { uploadDir } = {}) {
  const room = rooms.get(roomId);
  if (!room) return;

  clearTimeout(room.cleanupTimer);
  clearTimeout(room.expiryTimer);

  Object.values(room.files || {}).forEach((fileUrl) => {
    if (!fileUrl || !uploadDir) return;
    safeUnlink(path.join(uploadDir, path.basename(fileUrl)));
  });

  room.cleanupCallbacks?.forEach((callback) => callback(roomId));
  rooms.delete(roomId);
}

function scheduleExpiry(rooms, roomId, options = {}) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.expiryTimer);
  room.expiryTimer = setRoomTimer(
    () => cleanupRoom(rooms, roomId, options),
    Number(options.ttlMs || DEFAULT_ROOM_TTL_MS)
  );
}

function createRoom(rooms, roomId, mode = "LAN", options = {}) {
  const room = normalizeRoom({}, roomId, mode);
  rooms.set(roomId, room);
  scheduleExpiry(rooms, roomId, options);
  return room;
}

function getOrCreateRoom(rooms, roomId, mode = "LAN", options = {}) {
  const room = rooms.get(roomId) || createRoom(rooms, roomId, mode, options);
  normalizeRoom(room, roomId, mode);
  if (!room.expiryTimer) scheduleExpiry(rooms, roomId, options);
  return room;
}

function registerRoomCleanup(room, callback) {
  if (!callback) return;
  room.cleanupCallbacks ||= new Set();
  room.cleanupCallbacks.add(callback);
}

function computeState(room) {
  const now = Date.now();
  const elapsed = room.state?.isPlaying ? (now - room.updatedAt) / 1000 : 0;
  return {
    currentTime: (room.state?.currentTime || 0) + elapsed,
    isPlaying: Boolean(room.state?.isPlaying),
    serverTime: now,
    videoUrl: room.files?.video || null,
    subsUrl: room.files?.subs || null,
    hlsUrl: room.files?.hls || null,
    mode: room.mode || "LAN",
    hostId: room.hostId || null,
    viewers: room.users?.size || 0
  };
}

module.exports = {
  cleanupRoom,
  computeState,
  getOrCreateRoom,
  normalizeRoomId,
  registerRoomCleanup,
  safeUnlink,
  setRoomTimer
};
