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
  fullscreen = false,
  compact = false
}) {
  const containerRef = useRef(null);
  const seekInputRef = useRef(null);
  const progressRef = useRef(null);
  const bufferRef = useRef(null);
  const handleRef = useRef(null);
  const timeRef = useRef(null);
  const rafRef = useRef(null);
  const hideTimerRef = useRef(null);
  const volumeHideTimerRef = useRef(null);
  const draggingRef = useRef(false);
  const seekRatioRef = useRef(0);
  const durationRef = useRef(duration || 0);
  const onSeekRef = useRef(onSeek);
  const onPlayPauseRef = useRef(onPlayPause);
  const onFullscreenRef = useRef(onFullscreen);
  const [visible, setVisible] = useState(true);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [volumePanelOpen, setVolumePanelOpen] = useState(false);
  const [speed, setSpeed] = useState(() => {
    try { return Number(localStorage.getItem('ss-speed')) || 1; } catch { return 1; }
  });
  const [volume, setVolume] = useState(() => {
    try { return Number(localStorage.getItem('ss-volume')) || 1; } catch { return 1; }
  });
  const [muted, setMuted] = useState(false);
  const lastVolumeRef = useRef(volume > 0 ? volume : 1);

  useEffect(() => {
    durationRef.current = duration || 0;
  }, [duration]);

  useEffect(() => {
    onSeekRef.current = onSeek;
    onPlayPauseRef.current = onPlayPause;
    onFullscreenRef.current = onFullscreen;
  }, [onSeek, onPlayPause, onFullscreen]);

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

  useEffect(() => () => {
    if (volumeHideTimerRef.current) clearTimeout(volumeHideTimerRef.current);
  }, []);

  // auto-hide logic
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function show() {
      if (speedMenuOpen || draggingRef.current) return setVisible(true);
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (!isPlaying) return;
      hideTimerRef.current = setTimeout(() => {
        if (!draggingRef.current && !speedMenuOpen && isPlaying) setVisible(false);
      }, 2500);
    }

    function onActivity(event) {
      if (event?.type === "mousemove") {
        const rect = el.getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      }
      show();
    }

    window.addEventListener('mousemove', onActivity);
    window.addEventListener('touchstart', onActivity, { passive: true });
    document.addEventListener('keydown', onActivity);

    // initial timer start
    show();

    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('touchstart', onActivity);
      document.removeEventListener('keydown', onActivity);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [speedMenuOpen, isPlaying]);

  // progress animation loop - update DOM directly to avoid rerenders
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function loop() {
      const dur = video.duration || duration || 0;
      const cur = video.currentTime || 0;
      const pct = dur ? (cur / dur) * 100 : 0;
      if (!draggingRef.current) {
        if (progressRef.current) progressRef.current.style.width = `${pct}%`;
        if (handleRef.current) handleRef.current.style.left = `${pct}%`;
        if (seekInputRef.current) seekInputRef.current.value = `${Math.round(pct * 10)}`;
        if (timeRef.current) timeRef.current.textContent = `${fmt(cur)} / ${fmt(dur)}`;
      }
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

  function getSeekDuration() {
    return videoRef.current?.duration || durationRef.current || 0;
  }

  function previewSeekValue(rawValue) {
    const ratio = Math.max(0, Math.min(1, Number(rawValue) / 1000));
    const dur = getSeekDuration();
    const time = dur * ratio;
    seekRatioRef.current = ratio;
    if (progressRef.current) progressRef.current.style.width = `${ratio * 100}%`;
    if (handleRef.current) handleRef.current.style.left = `${ratio * 100}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(time)} / ${fmt(dur)}`;
    return time;
  }

  function setSeekInputFromPointer(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const value = String(Math.round(ratio * 1000));
    event.currentTarget.value = value;
    previewSeekValue(value);
  }

  function beginSeek(event) {
    draggingRef.current = true;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setVisible(true);
    if (Number.isFinite(event?.clientX)) setSeekInputFromPointer(event);
  }

  function commitSeekValue(rawValue) {
    const time = previewSeekValue(rawValue);
    draggingRef.current = false;
    onSeekRef.current(time);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => { if (!speedMenuOpen) setVisible(false); }, 2500);
    }
  }

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
        onSeekRef.current(Math.max(0, (video.currentTime || 0) - seekBy));
      } else {
        onSeekRef.current(Math.min(video.duration || durationRef.current || 0, (video.currentTime || 0) + seekBy));
      }
    }
    video.addEventListener('dblclick', onDbl);
    return () => video.removeEventListener('dblclick', onDbl);
  }, [videoRef]);

  // keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      const target = e.target;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); onPlayPauseRef.current(); }
      if (e.key === 'f' || e.key === 'F') { onFullscreenRef.current(); }
      if (e.key === 'ArrowRight') { const v = videoRef.current; if (v) onSeekRef.current(Math.min((v.duration||durationRef.current||0), (v.currentTime||0) + 5)); }
      if (e.key === 'ArrowLeft') { const v = videoRef.current; if (v) onSeekRef.current(Math.max(0, (v.currentTime||0) - 5)); }
    }
    
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [videoRef]);

  function skipBy(seconds) {
    const video = videoRef.current;
    if (!video) return;
    const max = video.duration || durationRef.current || 0;
    const nextTime = Math.max(0, Math.min(max, (video.currentTime || 0) + seconds));
    onSeekRef.current(nextTime);
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

  function showVolumePanel() {
    if (volumeHideTimerRef.current) clearTimeout(volumeHideTimerRef.current);
    setVolumePanelOpen(true);
    setVisible(true);
  }

  function scheduleVolumePanelClose() {
    if (volumeHideTimerRef.current) clearTimeout(volumeHideTimerRef.current);
    volumeHideTimerRef.current = setTimeout(() => setVolumePanelOpen(false), 1200);
  }

  const isMuted = muted || volume === 0;

  const barPosition = fullscreen
    ? "left-2 right-2 bottom-2 sm:left-4 sm:right-4 sm:bottom-4"
    : "left-4 right-4 bottom-4";
  const panelDensity = compact
    ? "gap-2 px-2 py-2 sm:gap-3 sm:px-3"
    : "gap-3 px-3 py-3 sm:gap-4 sm:px-4";

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
        <div className={`flex max-w-full flex-wrap items-center rounded-lg border border-white/10 bg-black/80 shadow-2xl backdrop-blur-xl ${panelDensity} lg:flex-nowrap`}>
          <button onClick={onPlayPause} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neon text-black transition hover:bg-neon/90">
            {isPlaying ? (
               <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
            ) : (
               <svg className="w-5 h-5 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>

          <div className="flex shrink-0 items-center gap-2">
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
            <div
              className="relative ml-1 flex items-center"
              onMouseEnter={showVolumePanel}
              onMouseLeave={scheduleVolumePanelClose}
              onFocus={showVolumePanel}
              onBlur={scheduleVolumePanelClose}
            >
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
              <div
                className={`absolute bottom-full left-1/2 mb-2 flex h-32 w-12 -translate-x-1/2 items-center justify-center rounded-lg border border-white/10 bg-black/90 px-2 py-3 shadow-xl backdrop-blur transition ${volumePanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
                onMouseEnter={showVolumePanel}
                onMouseLeave={scheduleVolumePanelClose}
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  onChange={(event) => setMediaVolume(event.target.value)}
                  className="volume-range cursor-pointer accent-neon"
                  aria-label="Volume"
                  title="Volume"
                />
              </div>
            </div>
          </div>

          <div className="order-first flex min-w-0 flex-[1_1_100%] items-center gap-3 sm:px-2 lg:order-none lg:flex-[1_1_auto]">
            <div className="ss-track group relative h-2 min-w-[120px] flex-1 overflow-visible rounded-full bg-white/10">
              <div ref={bufferRef} className="pointer-events-none absolute bottom-0 left-0 top-0 rounded-full bg-white/20" style={{ width: '0%' }} />
              <div ref={progressRef} className="pointer-events-none absolute bottom-0 left-0 top-0 rounded-full bg-neon shadow-[0_0_10px_rgba(57,255,136,0.3)]" style={{ width: '0%' }} />
              <div ref={handleRef} className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-[0_0_10px_rgba(57,255,136,0.8)] transition-opacity group-hover:opacity-100" style={{ left: '0%', transform: 'translate(-50%, -50%)' }} />
              <input
                ref={seekInputRef}
                type="range"
                min="0"
                max="1000"
                step="1"
                defaultValue="0"
                className="seek-range absolute -inset-y-3 left-0 z-10 h-8 w-full cursor-pointer touch-none"
                aria-label="Seek video"
                onPointerDown={beginSeek}
                onPointerMove={(event) => {
                  if (draggingRef.current && Number.isFinite(event.clientX)) setSeekInputFromPointer(event);
                }}
                onPointerUp={(event) => commitSeekValue(event.currentTarget.value)}
                onClick={(event) => commitSeekValue(event.currentTarget.value)}
                onPointerCancel={() => {
                  draggingRef.current = false;
                }}
                onInput={(event) => previewSeekValue(event.currentTarget.value)}
                onKeyDown={beginSeek}
                onKeyUp={(event) => commitSeekValue(event.currentTarget.value)}
              />
            </div>
            <div ref={timeRef} className="min-w-[88px] shrink-0 text-right font-mono text-[11px] font-medium text-neon sm:min-w-[96px] sm:text-xs">0:00 / 0:00</div>
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
