const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" }
];

export function hasTurnServer(iceServers: RTCIceServer[]) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => typeof url === "string" && url.startsWith("turn"));
  });
}

export function getIceServers(): RTCIceServer[] {
  const jsonConfig = process.env.NEXT_PUBLIC_ICE_SERVERS;
  if (jsonConfig) {
    try {
      const parsed = JSON.parse(jsonConfig);
      if (Array.isArray(parsed) && parsed.every((server) => server?.urls)) {
        return parsed;
      }
    } catch (error) {
      console.warn("Invalid NEXT_PUBLIC_ICE_SERVERS JSON, using defaults", error);
    }
  }

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    return [
      ...DEFAULT_ICE_SERVERS,
      {
        urls: turnUrl,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL
      }
    ];
  }

  return DEFAULT_ICE_SERVERS;
}
