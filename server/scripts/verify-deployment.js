#!/usr/bin/env node

const { io } = require("socket.io-client");

const DEFAULT_TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const urlArg = argv.find((arg) => !arg.startsWith("--"));
  const options = {
    baseUrl: urlArg || process.env.BINGE_SERVER_URL || process.env.SERVER_URL,
    requireInternet: argv.includes("--require-internet"),
    requireTurn: argv.includes("--require-turn"),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  const timeoutArg = argv.find((arg) => arg.startsWith("--timeout="));
  if (timeoutArg) {
    const parsed = Number(timeoutArg.split("=")[1]);
    if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = parsed;
  }

  return options;
}

function normalizeBaseUrl(url) {
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

async function fetchJson(baseUrl, path, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function waitForSocketState(baseUrl, transport, timeoutMs) {
  return new Promise((resolve, reject) => {
    const roomId = `VERIFY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const socket = io(baseUrl, {
      transports: [transport],
      forceNew: true,
      reconnection: false,
      timeout: timeoutMs
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${transport} join timed out`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.emit("join-room", { roomId, mode: "INTERNET" });
    });

    socket.on("state", (state) => {
      const socketId = socket.id;
      clearTimeout(timer);
      socket.close();
      resolve({
        transport,
        socketId,
        roomId,
        mode: state?.mode,
        viewers: state?.viewers
      });
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function assertEndpoint(name, result) {
  if (!result.ok) {
    throw new Error(`${name} returned HTTP ${result.status}`);
  }

  if (!result.body || typeof result.body !== "object") {
    throw new Error(`${name} returned an invalid JSON body`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  if (!baseUrl) {
    console.error("Usage: node scripts/verify-deployment.js <server-url> [--require-internet] [--require-turn] [--timeout=8000]");
    process.exit(2);
  }

  const health = await fetchJson(baseUrl, "/health", options.timeoutMs);
  assertEndpoint("/health", health);

  const ready = await fetchJson(baseUrl, "/ready", options.timeoutMs);
  assertEndpoint("/ready", ready);
  if (ready.body.status !== "ready" || ready.body.uploadDirWritable !== true) {
    throw new Error("/ready did not report a writable upload directory");
  }

  const diagnostics = await fetchJson(baseUrl, "/diagnostics", options.timeoutMs);
  assertEndpoint("/diagnostics", diagnostics);

  const internet = await fetchJson(baseUrl, "/internet-readiness", options.timeoutMs);
  assertEndpoint("/internet-readiness", internet);

  if (options.requireTurn && diagnostics.body.turnConfigured !== true) {
    throw new Error("TURN is required, but /diagnostics reports turnConfigured=false");
  }

  if (options.requireInternet) {
    if (internet.body.status !== "ready") {
      const failed = (internet.body.checks || [])
        .filter((check) => check.ready !== true)
        .map((check) => check.label)
        .join(", ");
      throw new Error(`Internet readiness failed${failed ? `: ${failed}` : ""}`);
    }
  }

  const websocket = await waitForSocketState(baseUrl, "websocket", options.timeoutMs);
  const polling = await waitForSocketState(baseUrl, "polling", options.timeoutMs);

  console.log(JSON.stringify({
    status: "ok",
    baseUrl,
    health: {
      uptimeSeconds: health.body.uptimeSeconds,
      rooms: health.body.rooms,
      turnConfigured: health.body.turnConfigured
    },
    ready: {
      uploadDirWritable: ready.body.uploadDirWritable
    },
    diagnostics: {
      activeRooms: diagnostics.body.activeRooms,
      activeCallRooms: diagnostics.body.activeCallRooms,
      corsOrigin: diagnostics.body.corsOrigin,
      turnConfigured: diagnostics.body.turnConfigured
    },
    internet: {
      status: internet.body.status,
      publicUrl: internet.body.publicUrl,
      checks: internet.body.checks
    },
    socket: {
      websocket,
      polling
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(`[verify-deployment] ${error.message}`);
  process.exit(1);
});
