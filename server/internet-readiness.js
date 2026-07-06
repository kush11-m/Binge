const net = require("net");

function getHostname(rawHost = "") {
  return rawHost.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}

function isPrivateHostname(hostname) {
  if (!hostname) return true;
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname)) return true;

  if (net.isIP(hostname) === 4) {
    const parts = hostname.split(".").map((part) => Number(part));
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254);
  }

  return false;
}

function assessInternetReadiness({ env = process.env, requestHost = "", forwardedProto = "", secure = false, turnConfigured = false, corsOrigin = "*" } = {}) {
  const publicUrl = env.PUBLIC_URL;
  let protocol = forwardedProto.split(",")[0]?.trim() || (secure ? "https" : "http");
  let host = requestHost;

  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      protocol = parsed.protocol.replace(":", "");
      host = parsed.host;
    } catch (_error) {
      // Keep request-derived values when PUBLIC_URL is malformed.
    }
  }

  const hostname = getHostname(host);
  const https = protocol === "https";
  const publicHost = !isPrivateHostname(hostname);
  const corsRestricted = corsOrigin !== "*";
  const ready = https && publicHost && turnConfigured;

  return {
    status: ready ? "ready" : "needs-attention",
    publicUrl: publicUrl || `${protocol}://${host}`,
    checks: [
      {
        id: "https",
        label: "HTTPS",
        ready: https,
        detail: https ? "Secure origin detected" : "Use HTTPS for internet rooms and camera/mic"
      },
      {
        id: "public-host",
        label: "Public host",
        ready: publicHost,
        detail: publicHost ? hostname : "Use a public domain or public IP, not localhost/LAN"
      },
      {
        id: "turn",
        label: "TURN relay",
        ready: turnConfigured,
        detail: turnConfigured ? "TURN configured" : "Configure TURN for restrictive networks"
      },
      {
        id: "cors",
        label: "CORS",
        ready: true,
        detail: corsRestricted ? "Restricted origins" : "Open to all origins"
      }
    ]
  };
}

module.exports = { assessInternetReadiness, isPrivateHostname };
