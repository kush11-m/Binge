import Head from "next/head";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import StreamingControls from "../../components/StreamingControls";
const VideoCall = dynamic(() => import("../../components/VideoCall"), { ssr: false });
import StatusPill from "../../components/StatusPill";
import { useSocket } from "../../hooks/useSocket";

const DRIFT_THRESHOLD = 0.45;
const DRIFT_SOFT_THRESHOLD = 0.15;
const DRIFT_INTERVAL = 2500;
const RATE_ADJUST = 0.04;
const HARD_JUMP_SECONDS = 1.0;

function Room() {
  const router = useRouter();
  const { roomId } = router.query;
  const resolvedRoomId = Array.isArray(roomId) ? roomId[0] : roomId;
  const [serverBase, setServerBase] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoSrc, setVideoSrc] = useState("");
  const [subsSrc, setSubsSrc] = useState("");
  const [subsEnabled, setSubsEnabled] = useState(true);
  const [error, setError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerContainerRef = useRef(null);
  const trackRef = useRef(null);
  const pendingPlayRef = useRef(null);
  const lastTimeUpdateRef = useRef(0);
  const skipSyncUntilRef = useRef(0);

  function pushDebug(message) {
    console.log('[room debug]', message);
  }
  const stateRef = useRef({
    currentTime: 0,
    isPlaying: false,
    serverTime: Date.now(),
    videoUrl: null,
    subsUrl: null
  });
  const offsetRef = useRef(0);
  const rateResetRef = useRef(null);
  const lastSyncStateRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname;
    const fallbackPort = process.env.NEXT_PUBLIC_SERVER_PORT || "3002";
    const base = process.env.NEXT_PUBLIC_SERVER_URL || `http://${host}:${fallbackPort}`;
    setServerBase(base);
  }, []);

  // Attach HLS.js when an HLS playlist is available for the current video
  useEffect(() => {
    let hlsInstance = null;
    let abort = false;
    async function tryAttachHls() {
      if (!videoRef.current || !serverBase || !stateRef.current.videoUrl) return;
      try {
        const baseName = stateRef.current.videoUrl.replace(/^\/video\//, '').replace(/\.[^/.]+$/, '');
        const hlsPath = `${serverBase}/streams/${baseName}-hls/index.m3u8`;
        // quick HEAD request to see if HLS exists
        const resp = await fetch(hlsPath, { method: 'HEAD' });
        if (!resp.ok) return;

        const Hls = (await import('hls.js')).default;
        if (!Hls || !Hls.isSupported()) return;
        const video = videoRef.current;
        hlsInstance = new Hls();
        hlsInstance.loadSource(hlsPath);
        hlsInstance.attachMedia(video);
        pushDebug(`attached hls ${hlsPath}`);
      } catch (err) {
        if (!abort) console.warn('HLS attach failed', err && err.message);
      }
    }

    tryAttachHls();

    return () => {
      abort = true;
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
    };
  }, [serverBase]);

  const socket = useSocket(serverBase);

  useEffect(() => {
    if (!socket || !resolvedRoomId) return;

    socket.emit("join-room", { roomId: resolvedRoomId });

    socket.on("room-full", () => {
      setError("Room is full (max 4 users). Try another session.");
    });

      socket.on("state", (state) => {
      if (!state) return;
      const now = Date.now();
      if (now < skipSyncUntilRef.current) {
        console.log('[room] skipped server state (debounce)');
        return;
      }
      handleServerState(state);
    });

    socket.on("connect", () => {
      console.log('[socket] connect');
    });
    socket.on("connect_error", (err) => {
      console.log('[socket] connect_error', err);
    });

    socket.on("disconnect", () => {
      setStatus("Host disconnected");
    });

    return () => {
      socket.off("room-full");
      socket.off("state");
      socket.off("disconnect");
    };
  }, [socket, resolvedRoomId, serverBase]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.mode = subsEnabled ? "showing" : "hidden";
  }, [subsEnabled, subsSrc]);

  // We no longer poll periodically. Syncs are driven only by play/pause/seek actions
  // emitted by the host. This avoids frequent micro-adjustments and reduces rendering.

  function updateOffset(serverTime) {
    const sample = serverTime - Date.now();
    offsetRef.current = offsetRef.current ? offsetRef.current * 0.8 + sample * 0.2 : sample;
  }

  function getExpectedTime() {
    const state = stateRef.current;
    if (!state.isPlaying) return state.currentTime || 0;
    const elapsed = (Date.now() + offsetRef.current - state.serverTime) / 1000;
    return state.currentTime + elapsed;
  }

  function handleServerState(state) {
    updateOffset(state.serverTime || Date.now());
    
    // Check if state actually changed; skip redundant syncs while paused
    const prev = lastSyncStateRef.current;
    const stateChanged =
      !prev ||
      Math.abs((prev.currentTime || 0) - (state.currentTime || 0)) > 0.1 ||
      prev.isPlaying !== Boolean(state.isPlaying) ||
      prev.videoUrl !== (state.videoUrl || null);

    stateRef.current = {
      currentTime: state.currentTime || 0,
      isPlaying: Boolean(state.isPlaying),
      serverTime: state.serverTime || Date.now(),
      videoUrl: state.videoUrl || null,
      subsUrl: state.subsUrl || null
    };

    if (state.videoUrl) setVideoSrc(`${serverBase}${state.videoUrl}`);
    if (state.subsUrl) setSubsSrc(`${serverBase}${state.subsUrl}`);
    if (!state.subsUrl) setSubsSrc("");

    // Only sync if state changed; don't repeatedly seek the same position
    if (stateChanged) {
      lastSyncStateRef.current = {
        currentTime: state.currentTime || 0,
        isPlaying: Boolean(state.isPlaying),
        videoUrl: state.videoUrl || null
      };
      syncVideo(true);
      setIsPlaying(Boolean(state.isPlaying));
      setStatus("Synced");
      pushDebug(`server state changed: time=${(state.currentTime || 0).toFixed(2)} playing=${!!state.isPlaying}`);
    } else {
      pushDebug(`server state unchanged (skipped sync): time=${(state.currentTime || 0).toFixed(2)}`);
    }
  }

  function syncVideo(forceJump) {
    const video = videoRef.current;
    if (!video || !stateRef.current.videoUrl) return;
    if (video.readyState < 2) return;

    const expected = getExpectedTime();
    const diff = expected - video.currentTime;
    const absDiff = Math.abs(diff);

    // Hard jump if we're out of sync by a lot (host authoritative)
    if (absDiff > HARD_JUMP_SECONDS) {
      video.currentTime = expected;
      video.playbackRate = 1;
      if (stateRef.current.isPlaying && video.paused) playWhenReady();
      if (!stateRef.current.isPlaying && !video.paused) video.pause();
      pushDebug(`hard jump to ${expected.toFixed(2)} (diff ${absDiff.toFixed(2)}s)`);
      return;
    }

    // If paused and already close to the expected position, skip seek to avoid stalls
    if (!stateRef.current.isPlaying && absDiff < 0.25) {
      if (!video.paused) video.pause();
      return;
    }

    if (forceJump || absDiff > DRIFT_THRESHOLD) {
      video.currentTime = expected;
      video.playbackRate = 1;
      if (stateRef.current.isPlaying && video.paused) playWhenReady();
      if (!stateRef.current.isPlaying && !video.paused) video.pause();
      return;
    }

    if (stateRef.current.isPlaying && absDiff > DRIFT_SOFT_THRESHOLD) {
      const rate = 1 + (diff > 0 ? RATE_ADJUST : -RATE_ADJUST);
      video.playbackRate = rate;
      if (rateResetRef.current) clearTimeout(rateResetRef.current);
      rateResetRef.current = setTimeout(() => {
        video.playbackRate = 1;
      }, 600);
    }
  }

  function playWhenReady() {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState >= 2) {
      video.play().catch(() => {});
      return;
    }

    if (pendingPlayRef.current) return;
    const handler = () => {
      video.play().catch(() => {});
      pendingPlayRef.current = null;
      video.removeEventListener("canplay", handler);
    };
    pendingPlayRef.current = handler;
    video.addEventListener("canplay", handler, { once: true });
  }

  function handlePlayPause() {
    const video = videoRef.current;
    if (!video || !socket || !resolvedRoomId) return;

    // debounce incoming server syncs for a short time after a local action
    skipSyncUntilRef.current = Date.now() + 1200;
    pushDebug(`local play/pause triggered (paused=${video.paused})`);
    if (video.paused) {
      playWhenReady();
      socket.emit("state", {
        roomId: resolvedRoomId,
        currentTime: video.currentTime,
        isPlaying: true
      });
      setIsPlaying(true);
    } else {
      video.pause();
      socket.emit("state", {
        roomId: resolvedRoomId,
        currentTime: video.currentTime,
        isPlaying: false
      });
      setIsPlaying(false);
    }
  }

  function handleSeek(time) {
    const video = videoRef.current;
    if (!video || !socket || !resolvedRoomId) return;
    // debounce incoming server syncs for a short time after a local seek
    skipSyncUntilRef.current = Date.now() + 1400;
    pushDebug(`local seek -> ${time.toFixed(2)}`);
    video.currentTime = time;
    socket.emit("state", { roomId: resolvedRoomId, currentTime: time, isPlaying });
    setCurrentTime(time);
  }

  function handleToggleSubs() {
    const track = trackRef.current;
    if (!track) return;
    const next = !subsEnabled;
    track.mode = next ? "showing" : "hidden";
    setSubsEnabled(next);
  }

  function handleFullscreen() {
    const container = playerContainerRef.current || videoContainerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }

    // Request fullscreen on the container so controls are visible
    const request = container.requestFullscreen?.call(container) || container.webkitRequestFullscreen?.call(container) || container.msRequestFullscreen?.call(container) || container.mozRequestFullScreen?.call(container);
    if (request?.catch) {
      request.catch(() => {});
    }
  }

  // Keep a body-level class in sync with fullscreen state to avoid relying on vendor pseudo-classes
  useEffect(() => {
    function onFsChange() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
      const nextFullscreen = Boolean(fsEl);
      setIsFullscreen(nextFullscreen);
      if (nextFullscreen) {
        document.body.classList.add('in-fullscreen');
      } else {
        document.body.classList.remove('in-fullscreen');
      }
    }

    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('mozfullscreenchange', onFsChange);
    document.addEventListener('MSFullscreenChange', onFsChange);

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      document.removeEventListener('mozfullscreenchange', onFsChange);
      document.removeEventListener('MSFullscreenChange', onFsChange);
      document.body.classList.remove('in-fullscreen');
    };
  }, []);

  function handlePlayerClick(event) {
    const controls = event.target.closest?.('.streaming-controls-ui');
    if (controls) return;
    handlePlayPause();
  }

  // Attach click handler directly to video element for reliable click-to-play/pause
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !socket || !resolvedRoomId) return;

    function onVideoClick(event) {
      // Toggle play/pause with a click
      const videoEl = videoRef.current;
      if (!videoEl) return;
      
      // debounce incoming server syncs for a short time after local action
      skipSyncUntilRef.current = Date.now() + 1200;
      pushDebug(`click-to-toggle triggered (paused=${videoEl.paused})`);
      
      if (videoEl.paused) {
        // Play the video
        const playPromise = videoEl.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.error("Play failed:", err);
          });
        }
        socket.emit("state", {
          roomId: resolvedRoomId,
          currentTime: videoEl.currentTime,
          isPlaying: true
        });
        setIsPlaying(true);
      } else {
        // Pause the video
        videoEl.pause();
        socket.emit("state", {
          roomId: resolvedRoomId,
          currentTime: videoEl.currentTime,
          isPlaying: false
        });
        setIsPlaying(false);
      }
    }

    // Use capture phase to catch clicks before anything else can intercept
    video.addEventListener('click', onVideoClick, true);
    return () => video.removeEventListener('click', onVideoClick, true);
  }, [resolvedRoomId, socket]);

  const statusLabel = useMemo(() => {
    if (error) return "Error";
    return status;
  }, [status, error]);

  return (
    <div className={isFullscreen ? "min-h-screen bg-black text-white" : "room-page min-h-screen bg-atmos px-6 py-10"}>
      <Head>
        <title>Room {resolvedRoomId} - Binge</title>
      </Head>

      <div className={isFullscreen ? "mx-auto w-full" : "room-page-shell max-w-5xl mx-auto space-y-6"}>
        {!isFullscreen && (
          <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.4em] text-white/40">Viewer</p>
            <h1 className="text-3xl font-semibold neon-text">Room {resolvedRoomId}</h1>
          </div>
          <StatusPill label={statusLabel} />
          </header>
        )}

        {error && <div className="panel rounded-xl p-4 text-red-400">{error}</div>}

        <div className={isFullscreen ? "relative min-h-screen" : "panel rounded-xl p-4"}>
          <div
            ref={playerContainerRef}
            className={isFullscreen ? "relative min-h-screen" : "room-layout grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] relative"}
          >
            {isFullscreen && (
              <div className="pointer-events-none absolute left-0 right-0 top-5 z-40">
                <div className="mx-auto flex w-[min(90vw,1200px)] items-center justify-between rounded-full border border-white/10 bg-black/40 px-4 py-2 backdrop-blur">
                  <button
                    onClick={() => handleFullscreen()}
                    className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs text-white/80 transition hover:text-white"
                    title="Exit Fullscreen"
                  >
                    ⛶ Exit
                  </button>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-[#39FF88] font-semibold tracking-wide">Binge</span>
                    <span className="rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs text-white/80">Room: {resolvedRoomId}</span>
                  </div>
                  <div className="pointer-events-auto rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs text-white/80">4</div>
                </div>
              </div>
            )}
            <div className={isFullscreen ? "relative min-h-screen" : "contents"}>
              {isFullscreen && (
                <aside className="absolute right-0 top-0 bottom-0 w-[240px] border-l border-white/10 bg-black/20 p-3 backdrop-blur-xl">
                  <VideoCall socket={socket} roomId={resolvedRoomId} compact fullscreen={isFullscreen} />
                </aside>
              )}
              <div
                ref={videoContainerRef}
                className={isFullscreen ? "fullscreen-stage relative mr-[240px] w-[calc(100vw-240px)] h-screen flex items-center justify-center" : "fullscreen-stage relative w-full rounded-2xl bg-black overflow-hidden"}
              >
                <div className="relative w-[min(calc(100vw-320px),1320px)] max-h-[80vh] aspect-video rounded-2xl bg-black/90 shadow-[0_30px_80px_rgba(0,0,0,0.6)] overflow-hidden">
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    className="h-full w-full object-contain bg-black"
                  controls={false}
                  playsInline
                  preload="auto"
                  crossOrigin="anonymous"
                  onError={(e) => {
                    const mediaError = e.currentTarget?.error;
                    console.error("Video playback error:", mediaError || e);

                    if (mediaError?.code === 4) {
                      setError("Video format is not supported by this browser. Use a browser-compatible MP4 (H.264/AAC) or WebM file.");
                    } else if (mediaError?.code === 2) {
                      setError("Network error while loading the video. Check the video URL and server connectivity.");
                    } else if (mediaError?.code === 3) {
                      setError("Video decoding failed. The file may be corrupted.");
                    } else {
                      setError("Video playback error. See console for details.");
                    }
                  }}
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                  onLoadedData={() => syncVideo(true)}
                  onTimeUpdate={(event) => {
                    const now = Date.now();
                    const time = event.currentTarget.currentTime;
                    if (now - lastTimeUpdateRef.current > 200) {
                      lastTimeUpdateRef.current = now;
                      setCurrentTime(time);
                    }
                  }}
                  onPlay={() => { setIsPlaying(true); pushDebug('video:onPlay'); }}
                  onPause={() => { setIsPlaying(false); pushDebug('video:onPause'); }}
                  onWaiting={() => pushDebug('video:onWaiting')}
                  onStalled={() => pushDebug('video:onStalled')}
                  onAbort={() => pushDebug('video:onAbort')}
                  onCanPlayThrough={() => pushDebug('video:onCanPlayThrough')}
                  onSeeking={() => pushDebug('video:onSeeking')}
                  onSeeked={() => pushDebug('video:onSeeked')}
                  onSuspend={() => pushDebug('video:onSuspend')}
                  onEnded={() => pushDebug('video:onEnded')}
                  >
                    {subsSrc && (
                      <track
                        ref={trackRef}
                        src={subsSrc}
                        kind="subtitles"
                        srcLang="en"
                        label="English"
                        default
                      />
                    )}
                  </video>
                  <StreamingControls
                    videoRef={videoRef}
                    isPlaying={isPlaying}
                    duration={duration}
                    onPlayPause={handlePlayPause}
                    onSeek={handleSeek}
                    onToggleSubs={handleToggleSubs}
                    subsEnabled={subsEnabled}
                    onFullscreen={handleFullscreen}
                    fullscreen={isFullscreen}
                  />
                </div>
              </div>
              {!isFullscreen && (
                <aside className="lg:sticky lg:top-6 self-start">
                  <VideoCall socket={socket} roomId={resolvedRoomId} compact fullscreen={isFullscreen} />
                </aside>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default React.memo(Room);
