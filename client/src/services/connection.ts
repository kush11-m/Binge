import type { StreamMode } from "../types";

export function normalizeServerBase(serverBase: string) {
  if (!serverBase || typeof window === "undefined") return serverBase;

  try {
    const parsed = new URL(serverBase);
    if (parsed.hostname === "localhost" && isLocalHostname(window.location.hostname)) {
      parsed.hostname = "127.0.0.1";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch (_error) {
    return serverBase;
  }

  return serverBase.replace(/\/$/, "");
}

export function getDefaultServerBase() {
  if (process.env.NEXT_PUBLIC_SERVER_URL) return normalizeServerBase(process.env.NEXT_PUBLIC_SERVER_URL);
  if (typeof window === "undefined") return "";

  const fallbackPort = process.env.NEXT_PUBLIC_SERVER_PORT || "3002";
  const hostname = isLocalHostname(window.location.hostname) ? "127.0.0.1" : window.location.hostname;
  return `http://${hostname}:${fallbackPort}`;
}

export function getDefaultStreamMode() {
  if (typeof window === "undefined") return "LAN";
  return isLocalHostname(window.location.hostname) ? "LAN" : "INTERNET";
}

export function buildRoomPath(roomId: string, mode: StreamMode | string, options: { serverBase?: string; host?: boolean } = {}) {
  const params = new URLSearchParams({ mode: mode === "INTERNET" ? "INTERNET" : "LAN" });
  if (options.serverBase) params.set("server", options.serverBase);
  if (options.host) params.set("host", "1");
  return `/room/${encodeURIComponent(roomId)}?${params.toString()}`;
}

export function isLocalHostname(hostname: string) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}
