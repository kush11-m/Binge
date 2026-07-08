import Head from "next/head";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import StreamingControls from "../../components/StreamingControls";
import { SyncEngine } from "../../services/SyncEngine";
import { buildRoomPath, getDefaultServerBase, normalizeServerBase } from "../../services/connection";
import { getLocalMedia } from "../../services/localMediaStore";
import { useSocket } from "../../hooks/useSocket";
import { useStreaming } from "../../hooks/useStreaming";
import type { ProviderStatus, RoomState, StreamMode } from "../../types";

const VideoCall = dynamic(() => import("../../components/VideoCall"), { ssr: false });

function Room() {
  const router = useRouter();
  const { roomId } = router.query;
  const resolvedRoomId = Array.isArray(roomId) ? roomId[0] : roomId;
  const mode = (router.query.mode === "INTERNET" ? "INTERNET" : "LAN") as StreamMode;
  const isHost = router.query.host === "1";

  const [serverBase, setServerBase] = useState("");
  const [, setStatus] = useState("Connecting");
  const [, setProviderStatus] = useState<ProviderStatus>({ label: "Preparing" });
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [subsSrc, setSubsSrc] = useState("");
  const [subsEnabled, setSubsEnabled] = useState(true);
  const [error, setError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<"invite" | "code" | "">("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerContainerRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLTrackElement | null>(null);
  const syncEngineRef = useRef(new SyncEngine());
  const pendingPlayRef = useRef<(() => void) | null>(null);
  const lastTimeUpdateRef = useRef(0);
  const localObjectUrlRef = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const serverOverride = Array.isArray(router.query.server) ? router.query.server[0] : router.query.server;
    const nextServerBase = normalizeServerBase(serverOverride || getDefaultServerBase());
    setServerBase(nextServerBase);
    setOrigin(window.location.origin);
  }, [router.query.server]);

  const { socket } = useSocket(serverBase);
  const provider = useStreaming(
    socket,
    resolvedRoomId || null,
    roomState?.mode || mode,
    roomState?.videoUrl || null,
    isHost,
    roomState?.hostId || null,
    roomState?.hlsUrl || null,
    serverBase
  );

  useEffect(() => {
    if (!socket || !resolvedRoomId) return;

    function joinRoom() {
      socket.emit("join-room", { roomId: resolvedRoomId, mode, asHost: isHost });
      socket.emit("sync-request", { roomId: resolvedRoomId });
    }

    function onState(state: RoomState) {
      if (!state) return;
      const accepted = syncEngineRef.current.updateServerState(state);
      setRoomState(state);
      setIsPlaying(Boolean(state.isPlaying));
      setStatus(state.videoUrl ? "Synced" : "Waiting");
      if (state.subsUrl) setSubsSrc(`${serverBase}${state.subsUrl}`);
      if (!state.subsUrl) setSubsSrc("");
      if (accepted && videoRef.current) syncEngineRef.current.syncVideo(videoRef.current, true);
    }

    function onRoomFull() {
      setError("This room is full. Ask the host to create a new room.");
    }

    function onPresence(presence: Pick<RoomState, "viewers" | "hostId">) {
      setRoomState((current) => current ? { ...current, ...presence } : current);
    }

    socket.on("state", onState);
    socket.on("room-full", onRoomFull);
    socket.on("presence", onPresence);
    socket.on("connect", joinRoom);
    socket.on("disconnect", () => setStatus("Reconnecting"));
    joinRoom();

    return () => {
      socket.off("state", onState);
      socket.off("room-full", onRoomFull);
      socket.off("presence", onPresence);
      socket.off("connect", joinRoom);
      socket.off("disconnect");
    };
  }, [socket, resolvedRoomId, mode, isHost, serverBase]);

  useEffect(() => {
    if (!provider || !videoRef.current) return;

    const video = videoRef.current;
    void provider.attach(video);
    setProviderStatus(provider.getStatus());

    const onStatus = (event: Event) => setProviderStatus((event as CustomEvent<ProviderStatus>).detail);
    const onRemoteStream = (event: Event) => {
      video.srcObject = (event as CustomEvent<MediaStream>).detail;
      setProviderStatus((current) => ({
        ...current,
        label: "Internet live",
        detail: "Receiving host stream",
        quality: current.quality || "Adaptive WebRTC",
        transport: current.transport || "WebRTC"
      }));
    };

    provider.addEventListener("status", onStatus);
    provider.addEventListener("remote-stream", onRemoteStream);

    return () => {
      provider.removeEventListener("status", onStatus);
      provider.removeEventListener("remote-stream", onRemoteStream);
    };
  }, [provider]);

  useEffect(() => {
    if (!isHost || !resolvedRoomId || roomState?.mode !== "INTERNET" || !roomState?.videoUrl?.startsWith("p2p://")) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;

    async function attachLocalSource() {
      const media = await getLocalMedia(resolvedRoomId);
      if (cancelled) return;

      if (!media?.videoFile) {
        setError("This internet room needs the host's original local video. Reopen the host setup page and prepare the room again.");
        return;
      }

      if (localObjectUrlRef.current) URL.revokeObjectURL(localObjectUrlRef.current);
      const nextUrl = URL.createObjectURL(media.videoFile);
      localObjectUrlRef.current = nextUrl;
      video.srcObject = null;
      video.src = nextUrl;
      video.preload = "auto";
      video.load();
      await provider?.attach(video);
    }

    void attachLocalSource();

    return () => {
      cancelled = true;
    };
  }, [isHost, provider, resolvedRoomId, roomState?.mode, roomState?.videoUrl]);

  useEffect(() => () => {
    if (localObjectUrlRef.current) URL.revokeObjectURL(localObjectUrlRef.current);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (track?.track) track.track.mode = subsEnabled ? "showing" : "hidden";
  }, [subsEnabled, subsSrc]);

  useEffect(() => {
    function onFsChange() {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      document.body.classList.toggle("in-fullscreen", active);
    }

    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.body.classList.remove("in-fullscreen");
    };
  }, []);

  function playWhenReady() {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState >= 2 || video.srcObject) {
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

  function emitState(nextPlaying: boolean, nextTime?: number) {
    if (!socket || !resolvedRoomId || !videoRef.current) return;
    const time = Number.isFinite(nextTime) ? Number(nextTime) : videoRef.current.currentTime;
    syncEngineRef.current.setSkipSync(1200);
    socket.emit("state", {
      roomId: resolvedRoomId,
      currentTime: time,
      isPlaying: nextPlaying
    });
  }

  function handlePlayPause() {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      playWhenReady();
      setIsPlaying(true);
      emitState(true);
    } else {
      video.pause();
      setIsPlaying(false);
      emitState(false);
    }
  }

  function handleSeek(time: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    setCurrentTime(time);
    emitState(isPlaying, time);
  }

  function handleFullscreen() {
    const container = playerContainerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    container.requestFullscreen?.().catch(() => {});
  }

  const effectiveMode = (roomState?.mode || mode) as StreamMode;
  const ready = Boolean(roomState?.videoUrl);
  const showFullscreenCall = isFullscreen && callActive;
  const shareLink = useMemo(() => {
    if (!origin || !resolvedRoomId) return "";
    return `${origin}${buildRoomPath(resolvedRoomId, effectiveMode)}`;
  }, [effectiveMode, origin, resolvedRoomId]);

  async function writeClipboard(value: string) {
    if (!value) return false;
    try {
      await navigator.clipboard?.writeText(value);
      return true;
    } catch (_error) {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copiedValue = document.execCommand("copy");
      textarea.remove();
      return copiedValue;
    }
  }

  async function copyInvite() {
    if (!shareLink) return;
    if (await writeClipboard(shareLink)) {
      setCopied("invite");
      window.setTimeout(() => setCopied(""), 1600);
    }
  }

  async function copyRoomCode() {
    if (!resolvedRoomId) return;
    if (await writeClipboard(resolvedRoomId)) {
      setCopied("code");
      window.setTimeout(() => setCopied(""), 1600);
    }
  }

  const sharePanel = (
    <div className="rounded-lg border border-line bg-surface p-5 shadow-soft">
      <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted">Room Code</p>
      <h1 className="mt-2 break-all text-3xl font-semibold text-ink">{resolvedRoomId}</h1>
      <div className="mt-5 grid gap-2">
        <button
          className="h-11 rounded-lg bg-neon px-4 text-sm font-semibold text-black transition hover:bg-neon/90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={copyInvite}
          disabled={!shareLink}
        >
          {copied === "invite" ? "Invite link copied" : "Copy invite link"}
        </button>
        <button
          className="h-11 rounded-lg border border-line bg-wash px-4 text-sm font-semibold text-ink transition hover:border-neon/70 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={copyRoomCode}
          disabled={!resolvedRoomId}
        >
          {copied === "code" ? "Room code copied" : "Copy room code"}
        </button>
      </div>
    </div>
  );

  return (
    <main className={isFullscreen ? "min-h-screen bg-black text-white" : "min-h-screen bg-canvas px-4 py-5 text-ink sm:px-6 sm:py-6 lg:px-8"}>
      <Head>
        <title>{`Room ${resolvedRoomId || ""} - Binge`}</title>
      </Head>

      <div className={isFullscreen ? "w-full" : "mx-auto max-w-[1500px] space-y-5 sm:space-y-6"}>
        {!isFullscreen && (
          <header className="flex flex-wrap items-center justify-between gap-4">
            <button className="text-sm font-semibold text-muted transition hover:text-ink" onClick={() => router.push("/")}>
              Binge
            </button>
            <div className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-semibold text-muted shadow-soft">
              Room {resolvedRoomId}
            </div>
          </header>
        )}

        {error && <div className="rounded-lg border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>}

        <section
          ref={playerContainerRef}
          className={
            showFullscreenCall
              ? "fullscreen-room-grid grid h-[100dvh] min-h-0 grid-rows-[minmax(0,1fr)_minmax(180px,34dvh)] bg-black text-white lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:grid-rows-1"
              : isFullscreen
                ? "h-[100dvh] bg-black text-white"
              : "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]"
          }
        >
          <div className={isFullscreen ? "relative min-h-0 bg-black" : "rounded-lg border border-line bg-surface p-3 shadow-soft"}>
            <div className={isFullscreen ? "relative flex h-full min-h-0 items-center justify-center bg-black" : "relative overflow-hidden rounded-lg bg-black"}>
              {!ready && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black text-center text-white">
                  <div>
                    <p className="text-lg font-semibold">Waiting for the host upload</p>
                    <p className="mt-2 text-sm text-white/55">Room {resolvedRoomId}</p>
                  </div>
                </div>
              )}
              <video
                ref={videoRef}
                className={isFullscreen ? "h-full w-full object-contain" : "aspect-video h-full w-full object-contain"}
                controls={false}
                playsInline
                preload="auto"
                crossOrigin="anonymous"
                onClick={handlePlayPause}
                onError={(event) => {
                  const mediaError = event.currentTarget.error;
                  setError(mediaError?.message || "Video playback failed. Try a browser-compatible H.264/AAC MP4 or WebM file.");
                }}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                onLoadedData={() => videoRef.current && syncEngineRef.current.syncVideo(videoRef.current, true)}
                onTimeUpdate={(event) => {
                  const now = Date.now();
                  if (now - lastTimeUpdateRef.current > 180) {
                    lastTimeUpdateRef.current = now;
                    setCurrentTime(event.currentTarget.currentTime);
                  }
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              >
                {subsSrc && <track ref={trackRef} src={subsSrc} kind="subtitles" srcLang="en" label="English" default />}
              </video>
              <StreamingControls
                videoRef={videoRef}
                isPlaying={isPlaying}
                duration={duration}
                onPlayPause={handlePlayPause}
                onSeek={handleSeek}
                onToggleSubs={() => setSubsEnabled((current) => !current)}
                subsEnabled={subsEnabled}
                onFullscreen={handleFullscreen}
                fullscreen={isFullscreen}
                compact={showFullscreenCall}
              />
            </div>
          </div>

          <aside className={showFullscreenCall ? "fullscreen-call-rail min-h-0 overflow-hidden border-t border-white/10 bg-[#07100b] p-2 sm:p-3 lg:border-l lg:border-t-0" : isFullscreen ? "hidden" : "space-y-5"}>
            <VideoCall
              socket={socket}
              roomId={resolvedRoomId}
              compact={!isFullscreen}
              fullscreen={isFullscreen}
              onActiveChange={setCallActive}
            />
            {!isFullscreen && sharePanel}
          </aside>
        </section>
      </div>
    </main>
  );
}

export default React.memo(Room);
