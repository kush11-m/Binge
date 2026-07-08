import React, { useEffect, useRef, useState } from "react";

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function SkipIcon({ direction }) {
  const forward = direction === "forward";
  const triangleOne = forward
    ? "M7.5 6.75L12.5 12L7.5 17.25Z"
    : "M16.5 6.75L11.5 12L16.5 17.25Z";
  const triangleTwo = forward
    ? "M12 6.75L17 12L12 17.25Z"
    : "M12 6.75L7 12L12 17.25Z";
  const bar = forward ? "M5.75 6.75H7V17.25H5.75Z" : "M17 6.75H18.25V17.25H17Z";

  return (
    <svg className="h-[18px] w-[18px] text-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d={bar} fill="currentColor" />
      <path d={triangleOne} fill="currentColor" />
      <path d={triangleTwo} fill="currentColor" />
    </svg>
  );
}

function SeekButton({ direction, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="group flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-white/75 shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition duration-200 hover:border-neon/40 hover:bg-neon/10 hover:text-neon focus:outline-none focus-visible:ring-2 focus-visible:ring-neon/50"
      aria-label={label}
      title={label}
    >
      <SkipIcon direction={direction} />
    </button>
  );
}

export default function StreamingControls({
  videoRef,
  isPlaying,
  duration,
  onPlayPause,
  onSeek,
  onToggleSubs,
  subsEnabled,
  onFullscreen,
  fullscreen = false
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
  const [muted, setMuted] = useState(false);
  const lastVolumeRef = useRef(volume > 0 ? volume : 1);

  useEffect(() => {
    const v = videoRef?.current;
    if (!v) return;
    v.playbackRate = speed;
    v.volume = volume;
    v.muted = muted;
    try { localStorage.setItem('ss-speed', String(speed)); } catch {}
    try { localStorage.setItem('ss-volume', String(volume)); } catch {}
  }, [speed, volume, muted, videoRef]);

  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return;

    function onVolumeChange() {
      setVolume(video.volume);
      setMuted(video.muted || video.volume === 0);
      if (video.volume > 0) lastVolumeRef.current = video.volume;
    }

    onVolumeChange();
    video.addEventListener("volumechange", onVolumeChange);
    return () => video.removeEventListener("volumechange", onVolumeChange);
  }, [videoRef]);

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

  // keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (e.code === 'Space') { e.preventDefault(); onPlayPause(); }
      if (e.key === 'f' || e.key === 'F') { onFullscreen(); }
      if (e.key === 'ArrowRight') { const v = videoRef.current; if (v) v.currentTime = Math.min((v.duration||duration||0), (v.currentTime||0) + 5); }
      if (e.key === 'ArrowLeft') { const v = videoRef.current; if (v) v.currentTime = Math.max(0, (v.currentTime||0) - 5); }
    }
    
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onPlayPause, onFullscreen, videoRef, duration]);

  function skipBy(seconds) {
    const video = videoRef.current;
    if (!video) return;
    const max = video.duration || duration || 0;
    const nextTime = Math.max(0, Math.min(max, (video.currentTime || 0) + seconds));
    video.currentTime = nextTime;
    onSeek(nextTime);
  }

  function setMediaVolume(nextVolume) {
    const clamped = Math.max(0, Math.min(1, Number(nextVolume)));
    const video = videoRef.current;
    setVolume(clamped);
    if (clamped > 0) lastVolumeRef.current = clamped;
    const nextMuted = clamped === 0 ? true : false;
    setMuted(nextMuted);
    if (video) {
      video.volume = clamped;
      video.muted = nextMuted;
    }
  }

  function toggleMute() {
    const video = videoRef.current;
    const shouldMute = !(video?.muted || muted || volume === 0);

    if (shouldMute) {
      if (volume > 0) lastVolumeRef.current = volume;
      setMuted(true);
      if (video) video.muted = true;
      return;
    }

    const restoredVolume = lastVolumeRef.current || 1;
    setMuted(false);
    setVolume(restoredVolume);
    if (video) {
      video.volume = restoredVolume;
      video.muted = false;
    }
  }

  const isMuted = muted || volume === 0;

  const barPosition = fullscreen
    ? "left-4 right-4 bottom-4 sm:left-6 sm:right-6 sm:bottom-6"
    : "left-4 right-4 bottom-4";

  return (
    <div ref={containerRef} className="streaming-controls-ui absolute inset-0 z-20 pointer-events-none">
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${isPlaying ? 'opacity-0 pointer-events-none' : visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
        <div className="rounded-lg border border-white/10 bg-black/55 p-3 backdrop-blur-xl">
          <button onClick={onPlayPause} className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-lg bg-neon text-3xl text-black shadow-[0_16px_40px_rgba(57,255,136,0.22)] transition hover:bg-neon/90 sm:h-20 sm:w-20">
            ▶
          </button>
        </div>
      </div>

      <div className={`absolute ${barPosition} pointer-events-auto transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-black/80 px-3 py-3 shadow-2xl backdrop-blur-xl sm:flex-nowrap sm:gap-4 sm:px-4">
          <button onClick={onPlayPause} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neon text-black transition hover:bg-neon/90">
            {isPlaying ? (
               <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
            ) : (
               <svg className="w-5 h-5 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>

          <div className="flex items-center gap-2">
            <SeekButton
              direction="back"
              label="Rewind"
              onClick={() => skipBy(-10)}
            />
            <SeekButton
              direction="forward"
              label="Forward"
              onClick={() => skipBy(10)}
            />
            <div className="group/volume relative ml-1 flex items-center">
              <button
                onClick={toggleMute}
                className="rounded-md p-1 text-white/65 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neon/50"
                aria-label={isMuted ? "Unmute" : "Mute"}
                title={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted ? (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 9l4 4m0-4l-4 4" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                )}
              </button>
              <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 flex h-28 -translate-x-1/2 items-center rounded-lg border border-white/10 bg-black/90 px-2 py-3 opacity-0 shadow-xl backdrop-blur transition group-hover/volume:pointer-events-auto group-hover/volume:opacity-100 group-focus-within/volume:pointer-events-auto group-focus-within/volume:opacity-100">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  onChange={(event) => setMediaVolume(event.target.value)}
                  className="h-24 w-6 cursor-pointer accent-neon [writing-mode:vertical-lr]"
                  aria-label="Volume"
                  title="Volume"
                />
              </div>
            </div>
          </div>

          <div className="order-first flex w-full flex-1 items-center gap-3 sm:order-none sm:w-auto sm:px-2">
            <div className="w-full relative h-1.5 rounded-full bg-white/10 group cursor-pointer ss-track overflow-visible">
              <div ref={bufferRef} className="absolute left-0 top-0 bottom-0 bg-white/20 rounded-full" style={{ width: '0%' }} />
              <div ref={progressRef} className="absolute left-0 top-0 bottom-0 rounded-full bg-neon shadow-[0_0_10px_rgba(57,255,136,0.3)]" style={{ width: '0%' }} />
              <div ref={handleRef} className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full bg-white shadow-[0_0_10px_rgba(57,255,136,0.8)] opacity-0 transition-opacity group-hover:opacity-100" style={{ left: '0%', transform: 'translate(-50%, -50%)' }} />
            </div>
            <div ref={timeRef} className="min-w-[96px] shrink-0 text-right font-mono text-xs font-medium text-neon">0:00 / 0:00</div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
            <button onClick={onToggleSubs} className={`rounded-lg border border-white/10 px-2 py-1 text-xs font-semibold transition ${subsEnabled ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white'}`}>CC</button>
            <div className="relative pointer-events-auto">
              <button onClick={() => setSpeedMenuOpen(!speedMenuOpen)} className={`rounded-lg border border-white/10 px-2 py-1 text-xs font-semibold transition ${speedMenuOpen ? 'bg-white/10 text-white' : 'text-white/70 hover:text-white'}`}>{speed}x</button>
              {speedMenuOpen && (
                <div className="absolute right-0 bottom-full mb-2 min-w-[80px] rounded-lg border border-white/10 bg-black/90 p-1 shadow-xl backdrop-blur">
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(s => (
                    <button key={s} onClick={() => { setSpeed(s); setSpeedMenuOpen(false); }} className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm font-medium transition ${s===speed? 'text-[#39FF88] bg-white/5':'text-white/70 hover:text-white hover:bg-white/5'}`}>{s}x</button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={onFullscreen} className="rounded-lg p-1.5 text-white/65 transition hover:bg-white/10 hover:text-white" aria-label="Toggle fullscreen"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg></button>
          </div>
        </div>
      </div>
    </div>
  );
}
