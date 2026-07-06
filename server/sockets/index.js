const {
  cleanupRoom,
  computeState,
  getOrCreateRoom,
  normalizeRoomId,
  registerRoomCleanup,
  setRoomTimer
} = require("../rooms");

const MAX_USERS = Number(process.env.MAX_ROOM_USERS || 8);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 2 * 60 * 60 * 1000);
const EMPTY_ROOM_GRACE_MS = Number(process.env.EMPTY_ROOM_GRACE_MS || 2 * 60 * 1000);
const MAX_DISPLAY_NAME_LENGTH = 40;

function cleanRoomId(roomId) {
  return normalizeRoomId(roomId);
}

function cleanDisplayName(userName) {
  return String(userName || "").trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function attachSocketHandlers(io, rooms, { uploadDir }) {
  const callRooms = new Map();
  const roomOptions = { uploadDir, ttlMs: ROOM_TTL_MS };
  const cleanupCallRoom = (roomId) => callRooms.delete(roomId);

  function canSignalInRoom(socket, room, targetId) {
    if (!room || !targetId) return false;
    return room.users.has(socket.id) && room.users.has(targetId);
  }

  function canSignalInCallRoom(socket, roomId, targetId) {
    const peers = callRooms.get(roomId);
    if (!peers || !targetId) return false;
    return peers.has(socket.id) && peers.has(targetId);
  }

  function leaveCall(socket, roomId = socket.data.callRoomId) {
    if (!roomId) return;
    const peers = callRooms.get(roomId);
    if (!peers) return;

    peers.delete(socket.id);
    socket.to(`call:${roomId}`).emit("call-peer-left", { peerId: socket.id });
    socket.leave(`call:${roomId}`);
    socket.data.callRoomId = null;

    if (peers.size === 0) callRooms.delete(roomId);
  }

  io.on("connection", (socket) => {
    socket.on("join-room", ({ roomId, mode, asHost }) => {
      roomId = cleanRoomId(roomId);
      if (!roomId) return;

      const room = getOrCreateRoom(rooms, roomId, mode === "INTERNET" ? "INTERNET" : "LAN", roomOptions);
      registerRoomCleanup(room, cleanupCallRoom);
      if (room.users.size >= MAX_USERS && !room.users.has(socket.id)) {
        socket.emit("room-full");
        return;
      }

      room.users.add(socket.id);
      room.mode = mode === "INTERNET" ? "INTERNET" : room.mode || "LAN";
      if (asHost) room.hostId = socket.id;
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.isHost = Boolean(asHost);
      socket.emit("state", computeState(room));
      socket.emit("presence", { viewers: room.users.size, hostId: room.hostId });
      socket.to(roomId).emit("presence", { viewers: room.users.size, hostId: room.hostId });
    });

    socket.on("state", ({ roomId, currentTime, isPlaying }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      room.state = {
        currentTime: Number.isFinite(currentTime) ? currentTime : room.state.currentTime || 0,
        isPlaying: typeof isPlaying === "boolean" ? isPlaying : Boolean(room.state.isPlaying)
      };
      room.updatedAt = Date.now();
      socket.to(roomId).emit("state", computeState(room));
    });

    socket.on("sync-request", ({ roomId }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      if (room) socket.emit("state", computeState(room));
    });

    socket.on("internet-host-ready", ({ roomId }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      room.hostId = socket.id;
      room.mode = "INTERNET";
      socket.to(roomId).emit("internet-host-ready", { roomId, hostId: socket.id });
    });

    socket.on("internet-viewer-request", ({ roomId, hostId }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      const targetId = room?.hostId || hostId;
      if (!canSignalInRoom(socket, room, targetId)) return;
      io.to(targetId).emit("internet-viewer-request", { roomId, viewerId: socket.id });
    });

    socket.on("internet-offer", ({ roomId, targetId, sdp }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      if (sdp && canSignalInRoom(socket, room, targetId)) {
        io.to(targetId).emit("internet-offer", { roomId, fromId: socket.id, sdp });
      }
    });

    socket.on("internet-answer", ({ roomId, targetId, sdp }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      if (sdp && canSignalInRoom(socket, room, targetId)) {
        io.to(targetId).emit("internet-answer", { roomId, fromId: socket.id, sdp });
      }
    });

    socket.on("internet-ice-candidate", ({ roomId, targetId, candidate }) => {
      roomId = cleanRoomId(roomId);
      const room = rooms.get(roomId);
      if (candidate && canSignalInRoom(socket, room, targetId)) {
        io.to(targetId).emit("internet-ice-candidate", { roomId, fromId: socket.id, candidate });
      }
    });

    socket.on("join-call", ({ roomId }) => {
      roomId = cleanRoomId(roomId);
      if (!roomId) return;
      if (!callRooms.has(roomId)) callRooms.set(roomId, new Set());
      const peers = callRooms.get(roomId);
      const existingPeers = Array.from(peers).filter((peerId) => peerId !== socket.id);
      peers.add(socket.id);
      socket.data.callRoomId = roomId;
      socket.join(`call:${roomId}`);
      socket.emit("call-peers", { roomId, peerIds: existingPeers });
      socket.to(`call:${roomId}`).emit("call-peer-joined", { roomId, peerId: socket.id });
    });

    socket.on("leave-call", ({ roomId }) => leaveCall(socket, cleanRoomId(roomId) || socket.data.callRoomId));

    socket.on("webrtc-offer", ({ roomId, targetId, sdp }) => {
      roomId = cleanRoomId(roomId);
      if (sdp && canSignalInCallRoom(socket, roomId, targetId)) {
        io.to(targetId).emit("webrtc-offer", { roomId, fromId: socket.id, sdp });
      }
    });

    socket.on("webrtc-answer", ({ roomId, targetId, sdp }) => {
      roomId = cleanRoomId(roomId);
      if (sdp && canSignalInCallRoom(socket, roomId, targetId)) {
        io.to(targetId).emit("webrtc-answer", { roomId, fromId: socket.id, sdp });
      }
    });

    socket.on("webrtc-ice-candidate", ({ roomId, targetId, candidate }) => {
      roomId = cleanRoomId(roomId);
      if (candidate && canSignalInCallRoom(socket, roomId, targetId)) {
        io.to(targetId).emit("webrtc-ice-candidate", { roomId, fromId: socket.id, candidate });
      }
    });

    socket.on("broadcast-peer-status", ({ roomId, micEnabled, cameraEnabled, userName }) => {
      roomId = cleanRoomId(roomId);
      const peers = callRooms.get(roomId);
      if (!peers?.has(socket.id)) return;
      socket.to(`call:${roomId}`).emit("peer-status", {
        peerId: socket.id,
        micEnabled,
        cameraEnabled,
        userName: cleanDisplayName(userName)
      });
    });

    socket.on("disconnect", () => {
      leaveCall(socket);

      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      room.users.delete(socket.id);
      if (room.hostId === socket.id) {
        room.hostId = null;
      }
      socket.to(roomId).emit("presence", { viewers: room.users.size, hostId: room.hostId });

      if (room.users.size === 0) {
        room.cleanupTimer = setRoomTimer(() => cleanupRoom(rooms, roomId, roomOptions), EMPTY_ROOM_GRACE_MS);
      }
    });
  });

  return {
    getCallRoomCount() {
      return callRooms.size;
    }
  };
}

module.exports = { attachSocketHandlers };
