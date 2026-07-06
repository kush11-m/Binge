import { useMemo } from "react";

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = Math.floor(safeSeconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export default function PlayerControls({
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
  onToggleSubs,
  subsEnabled,
  onFullscreen
}) {
  const progress = useMemo(() => {
    if (!duration || duration === 0) return 0;
    return (currentTime / duration) * 100;
  }, [currentTime, duration]);

  return (
    <div className="w-full panel rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between text-sm text-white/70">
        <span className="font-mono">{formatTime(currentTime)}</span>
        <span className="font-mono">{formatTime(duration)}</span>
      </div>
      <input
        type="range"
        min="0"
        max={duration || 0}
        step="0.05"
        value={currentTime}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="w-full accent-neon"
        style={{ backgroundSize: `${progress}% 100%` }}
      />
      <div className="flex flex-wrap gap-3">
        <button
          onClick={onPlayPause}
          className="px-5 py-2 rounded-xl bg-neon text-black font-semibold shadow-glow hover:shadow-[0_0_24px_rgba(0,255,136,0.8)] transition"
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          onClick={onToggleSubs}
          className={`px-4 py-2 rounded-xl border ${
            subsEnabled ? "border-neon text-neon" : "border-white/20 text-white/60"
          } transition`}
        >
          {subsEnabled ? "Subs On" : "Subs Off"}
        </button>
        <button
          onClick={onFullscreen}
          className="px-4 py-2 rounded-xl border border-white/20 text-white/70 hover:border-neon hover:text-neon transition"
        >
          Fullscreen
        </button>
      </div>
    </div>
  );
}
