#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_ENV_FILE = path.join("deploy", ".env");
const PLACEHOLDERS = new Set([
  "",
  "app.example.com",
  "sync.example.com",
  "turn.example.com",
  "https://sync.example.com",
  "https://app.example.com",
  "replace-with-random-user",
  "replace-with-long-random-password",
  "change-me",
  "changeme",
  "your-user",
  "your-password"
]);

function parseEnv(contents) {
  return contents.split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return env;

    const separator = trimmed.indexOf("=");
    if (separator === -1) return env;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
    return env;
  }, {});
}

function isPlaceholder(value) {
  return PLACEHOLDERS.has(String(value || "").trim().toLowerCase());
}

function requireValue(env, key, errors) {
  const value = env[key];
  if (!value || isPlaceholder(value)) {
    errors.push(`${key} must be set to a real production value`);
  }
  return value || "";
}

function validateUrl(value, key, errors) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") errors.push(`${key} must use https`);
    if (isPlaceholder(parsed.hostname)) errors.push(`${key} must not use an example hostname`);
    return parsed;
  } catch (_error) {
    errors.push(`${key} must be a valid absolute URL`);
    return null;
  }
}

function validateHost(value, key, errors) {
  if (!value || isPlaceholder(value)) return;
  if (value.includes("://")) {
    errors.push(`${key} must be a hostname, not a URL`);
    return;
  }
  if (value === "localhost" || value.startsWith("127.") || value.startsWith("192.168.") || value.startsWith("10.")) {
    errors.push(`${key} must be publicly reachable, not localhost or a private LAN host`);
  }
}

function validateTurnUrl(value, errors) {
  const match = String(value || "").match(/^(turns?):([^/?]+)(?:[/?].*)?$/i);
  if (!match) {
    errors.push("NEXT_PUBLIC_TURN_URL must be a valid TURN URL");
    return;
  }

  const hostWithPort = match[2].replace(/^\[/, "").replace(/\]$/, "");
  const host = hostWithPort.includes(":") ? hostWithPort.split(":")[0] : hostWithPort;
  if (isPlaceholder(host)) {
    errors.push("NEXT_PUBLIC_TURN_URL must not use the example TURN host");
  }
}

function validateNumeric(env, key, min, max, errors) {
  if (env[key] == null || env[key] === "") return;
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${key} must be a number between ${min} and ${max}`);
  }
}

function validate(env) {
  const errors = [];
  const warnings = [];

  const appHost = requireValue(env, "PUBLIC_APP_HOST", errors);
  const backendHost = requireValue(env, "PUBLIC_BACKEND_HOST", errors);
  const publicUrl = requireValue(env, "PUBLIC_URL", errors);
  const corsOrigin = requireValue(env, "CORS_ORIGIN", errors);
  const turnRealm = requireValue(env, "TURN_REALM", errors);
  const turnUrl = requireValue(env, "NEXT_PUBLIC_TURN_URL", errors);
  requireValue(env, "NEXT_PUBLIC_TURN_USERNAME", errors);
  requireValue(env, "NEXT_PUBLIC_TURN_CREDENTIAL", errors);

  validateHost(appHost, "PUBLIC_APP_HOST", errors);
  validateHost(backendHost, "PUBLIC_BACKEND_HOST", errors);
  validateHost(turnRealm, "TURN_REALM", errors);
  if (appHost && backendHost && appHost === backendHost) {
    errors.push("PUBLIC_APP_HOST and PUBLIC_BACKEND_HOST should be separate hostnames");
  }

  const backendUrl = publicUrl ? validateUrl(publicUrl, "PUBLIC_URL", errors) : null;
  const appOrigin = corsOrigin ? validateUrl(corsOrigin, "CORS_ORIGIN", errors) : null;

  if (backendUrl && backendHost && backendUrl.hostname !== backendHost) {
    errors.push("PUBLIC_URL hostname must match PUBLIC_BACKEND_HOST");
  }
  if (appOrigin && appHost && appOrigin.hostname !== appHost) {
    errors.push("CORS_ORIGIN hostname must match PUBLIC_APP_HOST");
  }
  if (turnUrl) validateTurnUrl(turnUrl, errors);

  validateNumeric(env, "NEXT_PUBLIC_STREAM_RELAY_VIDEO_BITRATE", 1_000_000, 30_000_000, errors);
  validateNumeric(env, "MAX_ROOM_USERS", 1, 100, errors);
  validateNumeric(env, "MAX_UPLOAD_BYTES", 1_000_000, 1_099_511_627_776, errors);
  validateNumeric(env, "SOCKET_MAX_HTTP_BUFFER_SIZE", 1_000_000, 1_099_511_627_776, errors);

  if (env.NEXT_PUBLIC_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.NEXT_PUBLIC_ICE_SERVERS);
      if (!Array.isArray(parsed)) errors.push("NEXT_PUBLIC_ICE_SERVERS must be a JSON array");
      if (Array.isArray(parsed) && !parsed.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => typeof url === "string" && url.startsWith("turn"));
      })) {
        warnings.push("NEXT_PUBLIC_ICE_SERVERS does not include a TURN server");
      }
    } catch (_error) {
      errors.push("NEXT_PUBLIC_ICE_SERVERS must be valid JSON when set");
    }
  }

  return { errors, warnings };
}

function main(argv) {
  const envFile = argv[0] || DEFAULT_ENV_FILE;
  const absolutePath = path.resolve(envFile);
  if (!fs.existsSync(absolutePath)) {
    console.error(`[verify-internet-env] Missing env file: ${envFile}`);
    console.error("[verify-internet-env] Copy deploy/.env.internet.example to deploy/.env and set real values.");
    process.exit(2);
  }

  const env = parseEnv(fs.readFileSync(absolutePath, "utf8"));
  const { errors, warnings } = validate(env);
  warnings.forEach((warning) => console.warn(`[verify-internet-env] warning: ${warning}`));

  if (errors.length) {
    errors.forEach((error) => console.error(`[verify-internet-env] ${error}`));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: "ok",
    envFile,
    app: `https://${env.PUBLIC_APP_HOST}`,
    backend: env.PUBLIC_URL,
    turn: env.NEXT_PUBLIC_TURN_URL
  }, null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { parseEnv, validate };
