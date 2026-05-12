import React, { useEffect, useRef, useState } from "react";

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function StreamingControls({
  videoRef,
  isPlaying,
  duration,
  onPlayPause,
  onSeek,
  onToggleSubs,
  subsEnabled,
  onFullscreen
}) {
  const containerRef = useRef(null);
  const progressRef = useRef(null);
  const bufferRef = useRef(null);
  const handleRef = useRef(null);
  const timeRef = useRef(null);
  const rafRef = useRef(null);
  const hideTimerRef = useRef(null);
  const draggingRef = useRef(false);
  const [visible, setVisible] = useState(true);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [speed, setSpeed] = useState(() => {
    try { return Number(localStorage.getItem('ss-speed')) || 1; } catch { return 1; }
  });
  const [volume, setVolume] = useState(() => {
    try { return Number(localStorage.getItem('ss-volume')) || 1; } catch { return 1; }
  });

  useEffect(() => {
    const v = videoRef?.current;
    if (!v) return;
    v.playbackRate = speed;
    v.volume = volume;
    try { localStorage.setItem('ss-speed', String(speed)); } catch {}
    try { localStorage.setItem('ss-volume', String(volume)); } catch {}
  }, [speed, volume, videoRef]);

  // auto-hide logic
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function show() {
      if (speedMenuOpen || draggingRef.current) return setVisible(true);
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        if (!draggingRef.current && !speedMenuOpen) setVisible(false);
      }, 2500);
    }

    function onActivity() { show(); }

    el.addEventListener('mousemove', onActivity);
    el.addEventListener('mouseenter', onActivity);
    el.addEventListener('touchstart', onActivity, { passive: true });
    document.addEventListener('keydown', onActivity);

    // initial timer start
    show();

    return () => {
      el.removeEventListener('mousemove', onActivity);
      el.removeEventListener('mouseenter', onActivity);
      el.removeEventListener('touchstart', onActivity);
      document.removeEventListener('keydown', onActivity);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [speedMenuOpen]);

  // progress animation loop - update DOM directly to avoid rerenders
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function loop() {
      const dur = video.duration || duration || 0;
      const cur = video.currentTime || 0;
      const pct = dur ? (cur / dur) * 100 : 0;
      if (progressRef.current) progressRef.current.style.width = `${pct}%`;
      if (handleRef.current) handleRef.current.style.left = `${pct}%`;
      if (timeRef.current) timeRef.current.textContent = `${fmt(cur)} / ${fmt(dur)}`;
      // buffered
      try {
        if (bufferRef.current && video.buffered && video.buffered.length) {
          const end = video.buffered.end(video.buffered.length - 1);
          const bPct = dur ? (end / dur) * 100 : 0;
          bufferRef.current.style.width = `${Math.min(100, bPct)}%`;
        }
      } catch (e) {}

      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, duration]);

  // seeking handlers
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function getPos(evt) {
      const rect = container.getBoundingClientRect();
      const x = ('touches' in evt && evt.touches[0]) ? evt.touches[0].clientX : evt.clientX;
      return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    }

    function onDown(e) {
      draggingRef.current = true;
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setVisible(true);
      document.body.style.userSelect = 'none';
      const p = getPos(e);
      const t = (videoRef.current.duration || duration || 0) * p;
      if (handleRef.current) handleRef.current.style.left = `${p * 100}%`;
      if (progressRef.current) progressRef.current.style.width = `${p * 100}%`;
    }

    function onMove(e) {
      if (!draggingRef.current) return;
      const p = getPos(e);
      const t = (videoRef.current.duration || duration || 0) * p;
      if (handleRef.current) handleRef.current.style.left = `${p * 100}%`;
      if (progressRef.current) progressRef.current.style.width = `${p * 100}%`;
      if (timeRef.current) timeRef.current.textContent = `${fmt(t)} / ${fmt(videoRef.current.duration || duration || 0)}`;
    }

    function onUp(e) {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      const p = getPos(e);
      const t = (videoRef.current.duration || duration || 0) * p;
      onSeek(t);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => { if (!speedMenuOpen) setVisible(false); }, 2500);
    }

    const track = container.querySelector('.ss-track');
    if (track) {
      track.addEventListener('mousedown', onDown);
      track.addEventListener('touchstart', onDown, { passive: true });
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);

    return () => {
      if (track) {
        track.removeEventListener('mousedown', onDown);
        track.removeEventListener('touchstart', onDown);
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
  }, [videoRef, duration, onSeek]);

  // double-click seek
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function onDbl(e) {
      const rect = video.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const w = rect.width;
      const seekBy = 10;
      if (x < w / 2) {
        video.currentTime = Math.max(0, (video.currentTime || 0) - seekBy);
      } else {
        video.currentTime = Math.min(video.duration || duration || 0, (video.currentTime || 0) + seekBy);
      }
    }
    video.addEventListener('dblclick', onDbl);
    return () => video.removeEventListener('dblclick', onDbl);
  }, [videoRef, duration]);

  // keyboard shortcuts and video click-to-play
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    
    function onClick(e) {
      // Prevent click from triggering if clicking on controls area
      if (e.target !== video) return;
      onPlayPause();
    }
    
    function onKey(e) {
      if (e.code === 'Space') { e.preventDefault(); onPlayPause(); }
      if (e.key === 'f' || e.key === 'F') { onFullscreen(); }
      if (e.key === 'ArrowRight') { const v = videoRef.current; if (v) v.currentTime = Math.min((v.duration||duration||0), (v.currentTime||0) + 5); }
      if (e.key === 'ArrowLeft') { const v = videoRef.current; if (v) v.currentTime = Math.max(0, (v.currentTime||0) - 5); }
    }
    
    video.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      video.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [onPlayPause, onFullscreen, videoRef, duration]);

  return (
    <div ref={containerRef} className="absolute inset-0 z-20 pointer-events-none">
      {/* center large play when paused */}
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${isPlaying ? 'opacity-0 pointer-events-none' : visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
        <div className="bg-gradient-to-b from-black/60 to-black/40 rounded-full p-6">
          <button onClick={onPlayPause} className="w-20 h-20 rounded-full bg-black/60 text-neon flex items-center justify-center text-4xl shadow-[0_8px_30px_rgba(0,255,136,0.16)] transition transform hover:scale-105 pointer-events-auto">
            ▶
          </button>
        </div>
      </div>

      {/* bottom controls */}
      <div className={`absolute left-4 right-4 bottom-4 rounded-xl pointer-events-auto transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        <div className="backdrop-blur-sm bg-black/60 border border-black/30 rounded-xl p-3 shadow-lg flex flex-col gap-2">
          <div className="w-full relative h-3 rounded overflow-hidden ss-track cursor-pointer group hover:h-4 transition-all" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div ref={bufferRef} className="absolute left-0 top-0 bottom-0 bg-white/20" style={{ width: '0%' }} />
            <div ref={progressRef} className="absolute left-0 top-0 bottom-0 bg-[rgb(0,255,136)] shadow-[inset_0_0_6px_rgba(0,255,136,0.2)]" style={{ width: '0%' }} />
            <div ref={handleRef} className=\"absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-[0_0_10px_rgba(0,255,136,0.8)] transform opacity-0 group-hover:opacity-100 transition-opacity\" style={{ left: '0%', transform: 'translate(-50%, -50%)' }} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button onClick={onPlayPause} className="w-10 h-10 rounded-full bg-black/30 text-white/90 flex items-center justify-center pointer-events-auto">
                {isPlaying ? '❚❚' : '▶'}
              </button>
              <div ref={timeRef} className="text-xs text-white/80 font-mono">0:00 / 0:00</div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 pointer-events-auto">
                <button onClick={() => { setVolume(v => { const next = Math.max(0, Math.min(1, v - 0.1)); setVolume(next); if (videoRef.current) videoRef.current.volume = next; return next; }); }} className="text-white/80">🔉</button>
                <input type="range" min="0" max="1" step="0.01" value={volume} onChange={(e) => { const nv = Number(e.target.value); setVolume(nv); if (videoRef.current) videoRef.current.volume = nv; }} className="w-24" />
              </div>

              <button onClick={() => onToggleSubs()} className={`px-2 py-1 rounded text-sm ${subsEnabled ? 'text-neon' : 'text-white/70'} pointer-events-auto`}>CC</button>

              <div className="relative pointer-events-auto">
                <button onClick={() => setSpeedMenuOpen(!speedMenuOpen)} className={`px-2 py-1 rounded text-sm transition ${speedMenuOpen ? 'text-neon' : 'text-white/80'}`}>{speed}x</button>
                {speedMenuOpen && (
                  <div className="absolute right-0 bottom-full mb-2 bg-black/80 border border-white/20 rounded shadow-lg p-1 z-50 min-w-[80px]">
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(s => (
                      <button key={s} onClick={() => { setSpeed(s); setSpeedMenuOpen(false); }} className={`block w-full px-3 py-1 rounded text-sm text-left transition ${s===speed? 'text-neon bg-black/60':'text-white/70 hover:text-white'}`}>{s}x</button>
                    ))}
                  </div>
                )}
              </div>

              <button onClick={onFullscreen} className="px-2 py-1 rounded text-sm text-white/80 pointer-events-auto leading-none">⛶</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
