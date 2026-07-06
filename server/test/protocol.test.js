const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { io: createClient } = require("socket.io-client");

const { assessInternetReadiness, createBingeServer, getNetworkUrls, hasTurnConfig } = require("../server");

function once(socket, event, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off("connect_error", onError);
    }

    function onEvent(payload) {
      cleanup();
      resolve(payload);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on(event, onEvent);
    socket.on("connect_error", onError);
  });
}

function expectNoEvent(socket, event, timeoutMs = 80) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timer);
      socket.off(event, onEvent);
      reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
    }

    socket.on(event, onEvent);
  });
}

function connectClient(baseUrl) {
  const socket = createClient(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    timeout: 1000
  });
  return once(socket, "connect").then(() => socket);
}

function connectPollingClient(baseUrl) {
  const socket = createClient(baseUrl, {
    transports: ["polling"],
    forceNew: true,
    timeout: 1000
  });
  return once(socket, "connect").then(() => socket);
}

async function withServer(run) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "binge-test-"));
  const context = createBingeServer({
    uploadDir,
    env: {
      CORS_ORIGIN: "http://localhost:3000",
      NEXT_PUBLIC_TURN_URL: "turn:test.example.com:3478",
      NEXT_PUBLIC_TURN_USERNAME: "test-user",
      NEXT_PUBLIC_TURN_CREDENTIAL: "test-password",
      MAX_ROOM_USERS: "8"
    }
  });

  await new Promise((resolve) => context.httpServer.listen(0, "127.0.0.1", resolve));
  const address = context.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ ...context, baseUrl });
  } finally {
    await new Promise((resolve) => context.io.close(resolve));
    await new Promise((resolve) => context.httpServer.close(resolve));
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

test("reports health, readiness, and non-secret diagnostics", async () => {
  await withServer(async ({ baseUrl }) => {
    const root = await fetch(`${baseUrl}/`).then((res) => res.text());
    assert.match(root, /Binge sync server is running/);

    const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
    assert.equal(health.status, "ok");
    assert.equal(health.turnConfigured, true);

    const ready = await fetch(`${baseUrl}/ready`).then((res) => res.json());
    assert.deepEqual(ready, { status: "ready", uploadDirWritable: true });

    const diagnostics = await fetch(`${baseUrl}/diagnostics`).then((res) => res.json());
    assert.equal(diagnostics.status, "ok");
    assert.equal(diagnostics.turnConfigured, true);
    assert.equal(diagnostics.corsOrigin, "restricted");
    assert.equal(typeof diagnostics.activeRooms, "number");
    assert.equal(diagnostics.maxUploadBytes, 8589934592);
    assert.deepEqual(diagnostics.supportedSubtitleExtensions, [".srt", ".vtt"]);
    assert.ok(diagnostics.supportedVideoExtensions.includes(".mp4"));

    const network = await fetch(`${baseUrl}/network`).then((res) => res.json());
    assert.equal(network.status, "ok");
    assert.ok(Array.isArray(network.candidates));
  });
});

test("detects TURN config from explicit ICE server JSON", () => {
  assert.equal(hasTurnConfig({
    NEXT_PUBLIC_ICE_SERVERS: JSON.stringify([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:relay.example.com:3478", username: "relay-user", credential: "relay-password" }
    ])
  }), true);

  assert.equal(hasTurnConfig({
    NEXT_PUBLIC_ICE_SERVERS: JSON.stringify([{ urls: "stun:stun.l.google.com:19302" }])
  }), false);

  assert.equal(hasTurnConfig({
    NEXT_PUBLIC_ICE_SERVERS: JSON.stringify([
      { urls: "turn:turn.example.com:3478", username: "change-me", credential: "change-me" }
    ])
  }), false);
});

test("requires complete non-placeholder TURN environment config", () => {
  assert.equal(hasTurnConfig({
    NEXT_PUBLIC_TURN_URL: "turn:relay.example.com:3478",
    NEXT_PUBLIC_TURN_USERNAME: "relay-user",
    NEXT_PUBLIC_TURN_CREDENTIAL: "relay-password"
  }), true);

  assert.equal(hasTurnConfig({
    NEXT_PUBLIC_TURN_URL: "turn:turn.example.com:3478",
    NEXT_PUBLIC_TURN_USERNAME: "change-me",
    NEXT_PUBLIC_TURN_CREDENTIAL: "change-me"
  }), false);

  assert.equal(hasTurnConfig({
    NEXT_PUBLIC_TURN_URL: "turn:relay.example.com:3478",
    NEXT_PUBLIC_TURN_USERNAME: "relay-user"
  }), false);
});

test("reports LAN URL candidates without loopback addresses", async () => {
  const candidates = getNetworkUrls({
    port: 3002,
    interfaces: {
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
      awdl0: [{ family: "IPv6", address: "fe80::1", internal: false }]
    }
  });

  assert.deepEqual(candidates, [{
    interface: "en0",
    address: "192.168.1.20",
    url: "http://192.168.1.20:3002"
  }]);
});

test("assesses internet readiness without exposing secrets", () => {
  const ready = assessInternetReadiness({
    env: { PUBLIC_URL: "https://sync.example.com" },
    turnConfigured: true,
    corsOrigin: "https://app.example.com"
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.publicUrl, "https://sync.example.com");
  assert.equal(ready.checks.every((check) => typeof check.detail === "string"), true);

  const local = assessInternetReadiness({
    requestHost: "localhost:3002",
    forwardedProto: "http",
    turnConfigured: false
  });
  assert.equal(local.status, "needs-attention");
  assert.equal(local.checks.find((check) => check.id === "public-host").ready, false);
  assert.equal(local.checks.find((check) => check.id === "turn").ready, false);
});

test("joins internet rooms and broadcasts playback state", async () => {
  await withServer(async ({ baseUrl }) => {
    const host = await connectClient(baseUrl);
    const viewer = await connectClient(baseUrl);

    try {
      host.emit("join-room", { roomId: "ROOM1", mode: "INTERNET", asHost: true });
      const hostState = await once(host, "state");
      assert.equal(hostState.mode, "INTERNET");
      assert.equal(hostState.hostId, host.id);

      viewer.emit("join-room", { roomId: "ROOM1", mode: "INTERNET" });
      const viewerState = await once(viewer, "state");
      assert.equal(viewerState.mode, "INTERNET");
      assert.equal(viewerState.hostId, host.id);
      assert.equal(viewerState.viewers, 2);

      host.emit("state", { roomId: "ROOM1", currentTime: 12.5, isPlaying: true });
      const syncedState = await once(viewer, "state");
      assert.equal(syncedState.isPlaying, true);
      assert.ok(syncedState.currentTime >= 12.5);
    } finally {
      host.close();
      viewer.close();
    }
  });
});

test("preserves internet mode when a viewer joins from a code-only link", async () => {
  await withServer(async ({ baseUrl }) => {
    const host = await connectClient(baseUrl);
    const viewer = await connectClient(baseUrl);

    try {
      host.emit("join-room", { roomId: "ROOM1B", mode: "INTERNET", asHost: true });
      const hostState = await once(host, "state");
      assert.equal(hostState.mode, "INTERNET");

      viewer.emit("join-room", { roomId: "ROOM1B", mode: "LAN" });
      const viewerState = await once(viewer, "state");
      assert.equal(viewerState.mode, "INTERNET");
      assert.equal(viewerState.hostId, host.id);
    } finally {
      host.close();
      viewer.close();
    }
  });
});

test("accepts polling transport for proxy fallback", async () => {
  await withServer(async ({ baseUrl }) => {
    const viewer = await connectPollingClient(baseUrl);

    try {
      viewer.emit("join-room", { roomId: "POLL1", mode: "LAN" });
      const state = await once(viewer, "state");
      assert.equal(state.mode, "LAN");
      assert.equal(state.viewers, 1);
    } finally {
      viewer.close();
    }
  });
});

test("does not promote ordinary viewers to relay host after host disconnects", async () => {
  await withServer(async ({ baseUrl }) => {
    const host = await connectClient(baseUrl);
    const viewer = await connectClient(baseUrl);

    try {
      host.emit("join-room", { roomId: "ROOM1C", mode: "INTERNET", asHost: true });
      await once(host, "state");
      viewer.emit("join-room", { roomId: "ROOM1C", mode: "INTERNET" });
      await once(viewer, "state");

      host.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      viewer.emit("sync-request", { roomId: "ROOM1C" });
      const state = await once(viewer, "state");
      assert.equal(state.viewers, 1);
      assert.equal(state.hostId, null);
    } finally {
      viewer.close();
    }
  });
});

test("relays internet WebRTC signaling only to the target peer", async () => {
  await withServer(async ({ baseUrl }) => {
    const host = await connectClient(baseUrl);
    const viewer = await connectClient(baseUrl);

    try {
      host.emit("join-room", { roomId: "ROOM2", mode: "INTERNET", asHost: true });
      await once(host, "state");
      viewer.emit("join-room", { roomId: "ROOM2", mode: "INTERNET" });
      await once(viewer, "state");

      viewer.emit("internet-viewer-request", { roomId: "ROOM2", hostId: host.id });
      const request = await once(host, "internet-viewer-request");
      assert.equal(request.viewerId, viewer.id);

      host.emit("internet-offer", {
        roomId: "ROOM2",
        targetId: viewer.id,
        sdp: { type: "offer", sdp: "test-offer" }
      });
      const offer = await once(viewer, "internet-offer");
      assert.equal(offer.fromId, host.id);
      assert.equal(offer.sdp.sdp, "test-offer");

      viewer.emit("internet-answer", {
        roomId: "ROOM2",
        targetId: host.id,
        sdp: { type: "answer", sdp: "test-answer" }
      });
      const answer = await once(host, "internet-answer");
      assert.equal(answer.fromId, viewer.id);
      assert.equal(answer.sdp.sdp, "test-answer");
    } finally {
      host.close();
      viewer.close();
    }
  });
});

test("rejects internet signaling from sockets outside the target room", async () => {
  await withServer(async ({ baseUrl }) => {
    const host = await connectClient(baseUrl);
    const intruder = await connectClient(baseUrl);
    const viewer = await connectClient(baseUrl);

    try {
      host.emit("join-room", { roomId: "ROOM2A", mode: "INTERNET", asHost: true });
      await once(host, "state");
      intruder.emit("join-room", { roomId: "ROOM2B", mode: "INTERNET" });
      await once(intruder, "state");

      intruder.emit("internet-viewer-request", { roomId: "ROOM2A", hostId: host.id });
      await expectNoEvent(host, "internet-viewer-request");

      intruder.emit("internet-offer", {
        roomId: "ROOM2A",
        targetId: host.id,
        sdp: { type: "offer", sdp: "cross-room-offer" }
      });
      await expectNoEvent(host, "internet-offer");

      viewer.emit("join-room", { roomId: "ROOM2A", mode: "INTERNET" });
      await once(viewer, "state");
      viewer.emit("internet-viewer-request", { roomId: "ROOM2A", hostId: host.id });
      const request = await once(host, "internet-viewer-request");
      assert.equal(request.viewerId, viewer.id);
    } finally {
      host.close();
      intruder.close();
      viewer.close();
    }
  });
});

test("announces camera call peers", async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await connectClient(baseUrl);
    const second = await connectClient(baseUrl);

    try {
      first.emit("join-call", { roomId: "ROOM3" });
      const firstPeers = await once(first, "call-peers");
      assert.deepEqual(firstPeers.peerIds, []);

      second.emit("join-call", { roomId: "ROOM3" });
      const secondPeers = await once(second, "call-peers");
      assert.deepEqual(secondPeers.peerIds, [first.id]);

      const joined = await once(first, "call-peer-joined");
      assert.equal(joined.peerId, second.id);
    } finally {
      first.close();
      second.close();
    }
  });
});

test("rejects camera call signaling from peers outside the call room", async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await connectClient(baseUrl);
    const second = await connectClient(baseUrl);
    const intruder = await connectClient(baseUrl);

    try {
      first.emit("join-call", { roomId: "ROOM3B" });
      await once(first, "call-peers");
      second.emit("join-call", { roomId: "ROOM3B" });
      await once(second, "call-peers");
      await once(first, "call-peer-joined");

      intruder.emit("join-call", { roomId: "ROOM3C" });
      await once(intruder, "call-peers");

      intruder.emit("webrtc-offer", {
        roomId: "ROOM3B",
        targetId: first.id,
        sdp: { type: "offer", sdp: "cross-room-call-offer" }
      });
      await expectNoEvent(first, "webrtc-offer");

      intruder.emit("broadcast-peer-status", {
        roomId: "ROOM3B",
        micEnabled: false,
        cameraEnabled: false,
        userName: "Intruder"
      });
      await expectNoEvent(first, "peer-status");

      second.emit("webrtc-offer", {
        roomId: "ROOM3B",
        targetId: first.id,
        sdp: { type: "offer", sdp: "same-room-call-offer" }
      });
      const offer = await once(first, "webrtc-offer");
      assert.equal(offer.fromId, second.id);
      assert.equal(offer.sdp.sdp, "same-room-call-offer");
    } finally {
      first.close();
      second.close();
      intruder.close();
    }
  });
});

test("rejects upload requests without a video file", async () => {
  await withServer(async ({ baseUrl }) => {
    const form = new FormData();
    form.append("roomId", "UPLOAD1");
    form.append("mode", "INTERNET");

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form
    });

    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error, "roomId and video are required");
  });
});

test("rejects unsupported upload file types", async () => {
  await withServer(async ({ baseUrl }) => {
    const form = new FormData();
    form.append("roomId", "UPLOAD_BAD");
    form.append("mode", "LAN");
    form.append("video", new Blob([Buffer.from("not-video")], { type: "text/plain" }), "notes.txt");

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form
    });

    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.match(payload.error, /Unsupported video type/);
  });
});

test("rejects spoofed video uploads without a supported extension", async () => {
  await withServer(async ({ baseUrl }) => {
    const form = new FormData();
    form.append("roomId", "UPLOAD_SPOOF");
    form.append("mode", "LAN");
    form.append("video", new Blob([Buffer.from("not-really-video")], { type: "video/mp4" }), "clip.txt");

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form
    });

    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.match(payload.error, /Unsupported video type/);
  });
});

test("rejects malformed room ids before creating rooms", async () => {
  await withServer(async ({ baseUrl, rooms }) => {
    const socket = await connectClient(baseUrl);

    try {
      socket.emit("join-room", { roomId: "../bad-room-id-with-a-very-long-name", mode: "LAN" });
      await expectNoEvent(socket, "state");
      assert.equal(rooms.size, 0);

      const form = new FormData();
      form.append("roomId", "../bad");
      form.append("mode", "LAN");
      form.append("video", new Blob([Buffer.from("0123")], { type: "video/mp4" }), "clip.mp4");

      const response = await fetch(`${baseUrl}/upload`, {
        method: "POST",
        body: form
      });
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.error, "roomId and video are required");
      assert.equal(rooms.size, 0);
    } finally {
      socket.close();
    }
  });
});

test("uploads media and serves byte ranges", async () => {
  await withServer(async ({ baseUrl, rooms }) => {
    const media = new Blob([Buffer.from("0123456789abcdef")], { type: "video/mp4" });
    const form = new FormData();
    form.append("roomId", "UPLOAD2");
    form.append("mode", "LAN");
    form.append("video", media, "clip.mp4");

    const uploadResponse = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form
    });

    const upload = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(upload.mode, "LAN");
    assert.match(upload.videoUrl, /^\/video\/.+\.mp4$/);
    assert.equal(typeof rooms.get("UPLOAD2").expiryTimer?.hasRef, "function");

    const rangeResponse = await fetch(`${baseUrl}${upload.videoUrl}`, {
      headers: { Range: "bytes=2-5" }
    });

    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(await rangeResponse.text(), "2345");
  });
});

test("returns 404 for missing video and subtitle assets", async () => {
  await withServer(async ({ baseUrl }) => {
    const missingVideo = await fetch(`${baseUrl}/video/missing.mp4`);
    assert.equal(missingVideo.status, 404);

    const missingSubtitle = await fetch(`${baseUrl}/subs/missing.vtt`);
    assert.equal(missingSubtitle.status, 404);
  });
});

test("broadcasts uploaded media to waiting room viewers", async () => {
  await withServer(async ({ baseUrl }) => {
    const viewer = await connectClient(baseUrl);

    try {
      viewer.emit("join-room", { roomId: "UPLOAD3", mode: "INTERNET" });
      const initialState = await once(viewer, "state");
      assert.equal(initialState.videoUrl, null);

      const media = new Blob([Buffer.from("room-ready")], { type: "video/mp4" });
      const form = new FormData();
      form.append("roomId", "UPLOAD3");
      form.append("mode", "INTERNET");
      form.append("video", media, "ready.mp4");

      const uploadedStatePromise = once(viewer, "state");
      const uploadResponse = await fetch(`${baseUrl}/upload`, {
        method: "POST",
        body: form
      });
      assert.equal(uploadResponse.status, 200);

      const uploadedState = await uploadedStatePromise;
      assert.equal(uploadedState.mode, "INTERNET");
      assert.match(uploadedState.videoUrl, /^\/video\/.+\.mp4$/);
      assert.equal(uploadedState.isPlaying, false);
      assert.equal(uploadedState.viewers, 1);
    } finally {
      viewer.close();
    }
  });
});

test("prepares internet rooms without uploading video bytes", async () => {
  await withServer(async ({ baseUrl }) => {
    const viewer = await connectClient(baseUrl);

    try {
      viewer.emit("join-room", { roomId: "P2P001", mode: "INTERNET" });
      const initialState = await once(viewer, "state");
      assert.equal(initialState.videoUrl, null);

      const preparedStatePromise = once(viewer, "state");
      const prepareResponse = await fetch(`${baseUrl}/upload/p2p`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: "P2P001",
          videoName: "three-hour-screening.mp4",
          subsName: "captions.srt",
          subsText: "1\n00:00:01,000 --> 00:00:02,000\nReady\n"
        })
      });

      const prepared = await prepareResponse.json();
      assert.equal(prepareResponse.status, 200);
      assert.equal(prepared.mode, "INTERNET");
      assert.equal(prepared.videoUrl, "p2p://host/three-hour-screening.mp4");
      assert.match(prepared.subsUrl, /^\/subs\/.+\.vtt$/);

      const preparedState = await preparedStatePromise;
      assert.equal(preparedState.mode, "INTERNET");
      assert.equal(preparedState.videoUrl, "p2p://host/three-hour-screening.mp4");
      assert.match(preparedState.subsUrl, /^\/subs\/.+\.vtt$/);
      assert.equal(preparedState.isPlaying, false);
      assert.equal(preparedState.viewers, 1);

      const subtitle = await fetch(`${baseUrl}${prepared.subsUrl}`).then((res) => res.text());
      assert.match(subtitle, /^WEBVTT/);
      assert.match(subtitle, /00:00:01\.000 --> 00:00:02\.000/);
    } finally {
      viewer.close();
    }
  });
});
