const DEFAULT_RELAY_VIDEO_BITRATE = 8_000_000;
const MIN_RELAY_VIDEO_BITRATE = 1_000_000;
const MAX_RELAY_VIDEO_BITRATE = 30_000_000;

export function getRelayVideoBitrate() {
  const raw = process.env.NEXT_PUBLIC_STREAM_RELAY_VIDEO_BITRATE;
  const parsed = raw ? Number(raw) : DEFAULT_RELAY_VIDEO_BITRATE;
  if (!Number.isFinite(parsed)) return DEFAULT_RELAY_VIDEO_BITRATE;
  return Math.min(MAX_RELAY_VIDEO_BITRATE, Math.max(MIN_RELAY_VIDEO_BITRATE, parsed));
}

export function formatRelayBitrate(bitsPerSecond: number) {
  if (bitsPerSecond >= 1_000_000) return `${Math.round(bitsPerSecond / 100_000) / 10} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} Kbps`;
}
