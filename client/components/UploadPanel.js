export default function UploadPanel({
  videoFile,
  subsFile,
  onVideoChange,
  onSubsChange
}) {
  return (
    <div className="panel rounded-xl p-6 space-y-4">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/40">Video</p>
        <label className="mt-2 flex items-center justify-between border border-dashed border-white/20 rounded-xl px-4 py-3 cursor-pointer hover:border-neon/60 transition">
          <span className="text-white/70">
            {videoFile ? videoFile.name : "Drop mp4 or click to upload"}
          </span>
          <input
            type="file"
            accept="video/mp4,video/webm"
            className="hidden"
            onChange={onVideoChange}
          />
        </label>
      </div>
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/40">Subtitles</p>
        <label className="mt-2 flex items-center justify-between border border-dashed border-white/20 rounded-xl px-4 py-3 cursor-pointer hover:border-neon/60 transition">
          <span className="text-white/70">
            {subsFile ? subsFile.name : "Drop .vtt or .srt (optional)"}
          </span>
          <input
            type="file"
            accept="text/vtt,application/x-subrip,.srt"
            className="hidden"
            onChange={onSubsChange}
          />
        </label>
      </div>
    </div>
  );
}
