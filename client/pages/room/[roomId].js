import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";
import PlayerControls from "../../components/PlayerControls";
import StatusPill from "../../components/StatusPill";
import { useSocket } from "../../hooks/useSocket";

const DRIFT_THRESHOLD = 0.45;
const DRIFT_SOFT_THRESHOLD = 0.15;
const DRIFT_INTERVAL = 2500;
const RATE_ADJUST = 0.04;

export default function Room() {
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

  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const pendingPlayRef = useRef(null);
  const stateRef = useRef({
    currentTime: 0,
    isPlaying: false,
    serverTime: Date.now(),
    videoUrl: null,
    subsUrl: null
  });
  const offsetRef = useRef(0);
  const rateResetRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname;
    const fallbackPort = process.env.NEXT_PUBLIC_SERVER_PORT || "3002";
    setServerBase(process.env.NEXT_PUBLIC_SERVER_URL || `http://${host}:${fallbackPort}`);
  }, []);

  const socket = useSocket(serverBase);

  useEffect(() => {
    if (!socket || !resolvedRoomId) return;

    socket.emit("join-room", { roomId: resolvedRoomId });

    socket.on("room-full", () => {
      setError("Room is full (max 4 users). Try another session.");
    });

    socket.on("state", (state) => {
      if (!state) return;
      handleServerState(state);
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

  useEffect(() => {
    if (!socket || !resolvedRoomId) return;

    const interval = setInterval(() => {
      socket.emit("sync-request", { roomId: resolvedRoomId });
      syncVideo(false);
    }, DRIFT_INTERVAL);

    return () => clearInterval(interval);
  }, [socket, resolvedRoomId]);

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

    syncVideo(true);
    setIsPlaying(Boolean(state.isPlaying));
    setStatus("Synced");
  }

  function syncVideo(forceJump) {
    const video = videoRef.current;
    if (!video || !stateRef.current.videoUrl) return;
    if (video.readyState < 2) return;

    const expected = getExpectedTime();
    const diff = expected - video.currentTime;
    const absDiff = Math.abs(diff);

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
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    video.requestFullscreen().catch(() => {});
  }

  const statusLabel = useMemo(() => {
    if (error) return "Error";
    return status;
  }, [status, error]);

  return (
    <div className="min-h-screen bg-atmos px-6 py-10">
      <Head>
        <title>Room {resolvedRoomId} - SyncStream</title>
      </Head>

      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.4em] text-white/40">Viewer</p>
            <h1 className="text-3xl font-semibold neon-text">Room {resolvedRoomId}</h1>
          </div>
          <StatusPill label={statusLabel} />
        </header>

        {error && <div className="panel rounded-xl p-4 text-red-400">{error}</div>}

        <div className="panel rounded-xl p-4">
          <video
            ref={videoRef}
            src={videoSrc}
            className="w-full rounded-xl bg-black"
            playsInline
            preload="auto"
            crossOrigin="anonymous"
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            onLoadedData={() => syncVideo(true)}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
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
        </div>

        <PlayerControls
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          onPlayPause={handlePlayPause}
          onSeek={handleSeek}
          onToggleSubs={handleToggleSubs}
          subsEnabled={subsEnabled}
          onFullscreen={handleFullscreen}
        />
      </div>
    </div>
  );
}
