const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".ogg"];
const SUBTITLE_EXTENSIONS = [".vtt", ".srt"];

export function formatBytes(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = Number.isInteger(value) || value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

export function getFileExtension(file?: File | null) {
  const name = file?.name || "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

export function validateMediaSelection({ videoFile, subsFile, maxUploadBytes }: {
  videoFile?: File | null;
  subsFile?: File | null;
  maxUploadBytes?: number;
}) {
  if (!videoFile) return "Choose a video file first.";

  const videoExt = getFileExtension(videoFile);
  if (!VIDEO_EXTENSIONS.includes(videoExt) && !videoFile.type.startsWith("video/")) {
    return "Use a browser-playable video file, ideally H.264/AAC MP4 or WebM.";
  }

  if (maxUploadBytes && videoFile.size > maxUploadBytes) {
    return `Video is ${formatBytes(videoFile.size)}. This backend accepts up to ${formatBytes(maxUploadBytes)}.`;
  }

  if (subsFile) {
    const subsExt = getFileExtension(subsFile);
    if (!SUBTITLE_EXTENSIONS.includes(subsExt)) {
      return "Subtitles must be VTT or SRT.";
    }
  }

  return "";
}

export const videoAccept = "video/mp4,video/x-m4v,video/quicktime,video/webm,video/ogg,.mkv,.ogv,.ogg";
export const subtitleAccept = "text/vtt,application/x-subrip,.vtt,.srt";
