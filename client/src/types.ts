export type StreamMode = "LAN" | "INTERNET";

export type RoomState = {
  currentTime: number;
  isPlaying: boolean;
  serverTime: number;
  videoUrl?: string | null;
  subsUrl?: string | null;
  hlsUrl?: string | null;
  mode?: StreamMode;
  hostId?: string | null;
  viewers?: number;
};

export type ProviderStatus = {
  label: string;
  detail?: string;
  quality?: string;
  transport?: "LAN" | "WebRTC" | "TURN" | "HTTP";
  bitrateKbps?: number;
  roundTripMs?: number;
  packetLossPct?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
};
