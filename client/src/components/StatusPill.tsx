export default function StatusPill({ label }) {
  return (
    <span className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-muted shadow-soft">
      {label}
    </span>
  );
}
