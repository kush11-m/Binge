export default function StatusPill({ label }) {
  return (
    <span className="px-3 py-1 rounded-full text-xs uppercase tracking-[0.2em] bg-black border border-neon/40 text-neon shadow-glow">
      {label}
    </span>
  );
}
