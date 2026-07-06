import { subtitleAccept, videoAccept } from "../services/mediaLimits";

export default function UploadPanel({
  videoFile,
  subsFile,
  onVideoChange,
  onSubsChange,
  maxUploadLabel
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <p className="text-sm font-medium text-muted">Video</p>
        <label className="mt-2 flex min-h-28 cursor-pointer flex-col justify-between rounded-lg border border-dashed border-line bg-wash px-4 py-3 transition hover:border-neon/60">
          <span className="text-sm font-semibold text-ink">
            {videoFile ? videoFile.name : "Choose MP4 or WebM"}
          </span>
          <span className="text-sm text-muted">
            {maxUploadLabel ? `Up to ${maxUploadLabel}` : "Source file"}
          </span>
          <input
            type="file"
            accept={videoAccept}
            className="hidden"
            onChange={onVideoChange}
          />
        </label>
      </div>
      <div>
        <p className="text-sm font-medium text-muted">Subtitles</p>
        <label className="mt-2 flex min-h-28 cursor-pointer flex-col justify-between rounded-lg border border-dashed border-line bg-wash px-4 py-3 transition hover:border-neon/60">
          <span className="text-sm font-semibold text-ink">
            {subsFile ? subsFile.name : "Add VTT or SRT"}
          </span>
          <span className="text-sm text-muted">
            Optional
          </span>
          <input
            type="file"
            accept={subtitleAccept}
            className="hidden"
            onChange={onSubsChange}
          />
        </label>
      </div>
    </div>
  );
}
