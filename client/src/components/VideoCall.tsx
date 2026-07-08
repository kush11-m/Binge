import { useEffect, useMemo, useRef, useState } from "react";
import { getIceServers, hasTurnServer } from "../services/iceServers";

const CALL_QUALITY = {
  standard: {
    label: "Standard",
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    videoBitrate: 1_500_000,
    audioBitrate: 96_000
  },
  high: {
    label: "High",
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
    videoBitrate: 3_000_000,
    audioBitrate: 128_000
  },
  studio: {
    label: "Studio",
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
    videoBitrate: 5_000_000,
    audioBitrate: 160_000
  }
};

function attachStream(videoElement, stream) {
  if (!videoElement) return;
  if (videoElement.srcObject !== stream) {
    videoElement.srcObject = stream;
  }
}

export default function VideoCall({ socket, roomId, compact = false, fullscreen = false, onActiveChange = (_active) => {} }) {
  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef(new Map());
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const reconnectTimersRef = useRef(new Map());
  const joinedCallRef = useRef(false);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState("Idle");
  const [joined, setJoined] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [remotePeerIds, setRemotePeerIds] = useState([]);
  const [error, setError] = useState("");
  const [qualityMode, setQualityMode] = useState(() => {
    try { return localStorage.getItem("ss-call-quality") || "high"; } catch { return "high"; }
  });
  const [userName, setUserName] = useState(() => {
    try { return localStorage.getItem('ss-username') || ''; } catch { return ''; }
  });
  const [remotePeerStatus, setRemotePeerStatus] = useState(new Map());

  const peerConfig = useMemo<RTCConfiguration>(
    () => ({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 4,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    }),
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardownCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Constantly broadcast peer status to sync mic/camera indicators
  useEffect(() => {
    if (!socket || !roomId || !localReady) return;

    const broadcastInterval = setInterval(() => {
      socket.emit("broadcast-peer-status", {
        roomId,
        micEnabled,
        cameraEnabled,
        userName
      });
    }, 1000);

    return () => clearInterval(broadcastInterval);
  }, [socket, roomId, localReady, micEnabled, cameraEnabled, userName]);

  // Re-attach stream whenever camera state or ready state changes
  useEffect(() => {
    if (cameraEnabled && localReady && localVideoRef.current && localStreamRef.current) {
      attachStream(localVideoRef.current, localStreamRef.current);
    }
  }, [localReady, cameraEnabled]);

  useEffect(() => {
    remotePeerIds.forEach((peerId) => {
      const stream = peerConnectionsRef.current.get(peerId)?.remoteStream;
      const video = remoteVideoRefs.current.get(peerId);
      if (video && stream) {
        attachStream(video, stream);
      }
    });
  }, [remotePeerIds]);

  useEffect(() => {
    onActiveChange(Boolean(localReady || joined || remotePeerIds.length > 0));
  }, [joined, localReady, onActiveChange, remotePeerIds.length]);

  useEffect(() => {
    if (!socket || !roomId) return;

    function rejoinCall() {
      if (!joinedCallRef.current) return;
      socket.emit("join-call", { roomId, userName });
      broadcastPeerStatus();
    }

    function handleCallPeers(payload) {
      if (!payload || payload.roomId !== roomId) return;
      const peerIds = payload.peerIds || [];
      setRemotePeerIds((current) => Array.from(new Set([...current, ...peerIds])));
      peerIds.forEach((peerId) => {
        createPeerConnection(peerId, false);
      });
      setStatus(peerIds.length ? "Connecting" : "Ready");
    }

    function handlePeerJoined(payload) {
      if (!payload || payload.roomId !== roomId) return;
      const peerId = payload.peerId;
      if (!peerId || peerId === socket.id) return;
      setRemotePeerIds((current) => Array.from(new Set([...current, peerId])));
      createPeerConnection(peerId, true);
    }

    function handlePeerLeft(payload) {
      if (!payload || payload.peerId === socket.id) return;
      removePeer(payload.peerId);
    }

    function handleOffer(payload) {
      if (!payload || payload.roomId !== roomId) return;
      receiveOffer(payload.fromId, payload.sdp);
    }

    function handleAnswer(payload) {
      if (!payload || payload.roomId !== roomId) return;
      receiveAnswer(payload.fromId, payload.sdp);
    }

    function handleIce(payload) {
      if (!payload || payload.roomId !== roomId) return;
      receiveIce(payload.fromId, payload.candidate);
    }

    function handlePeerStatus(payload) {
      if (!payload) return;
      setRemotePeerStatus(prev => new Map(prev).set(payload.peerId, {
        micEnabled: payload.micEnabled,
        cameraEnabled: payload.cameraEnabled,
        userName: payload.userName || 'Guest'
      }));
    }

    socket.on("call-peers", handleCallPeers);
    socket.on("call-peer-joined", handlePeerJoined);
    socket.on("call-peer-left", handlePeerLeft);
    socket.on("webrtc-offer", handleOffer);
    socket.on("webrtc-answer", handleAnswer);
    socket.on("webrtc-ice-candidate", handleIce);
    socket.on("peer-status", handlePeerStatus);
    socket.on("connect", rejoinCall);

    return () => {
      socket.off("call-peers", handleCallPeers);
      socket.off("call-peer-joined", handlePeerJoined);
      socket.off("call-peer-left", handlePeerLeft);
      socket.off("webrtc-offer", handleOffer);
      socket.off("webrtc-answer", handleAnswer);
      socket.off("webrtc-ice-candidate", handleIce);
      socket.off("peer-status", handlePeerStatus);
      socket.off("connect", rejoinCall);
    };
  }, [socket, roomId, userName]);

  function createPeerConnection(peerId, initiateOffer) {
    if (!socket || !roomId || !peerId) return null;

    const existing = peerConnectionsRef.current.get(peerId);
    if (existing) {
      if (initiateOffer) {
        void startOffer(peerId, existing.pc);
      }
      return existing.pc;
    }

    const pc = new RTCPeerConnection(peerConfig);
    const remoteState = { pc, remoteStream: new MediaStream(), offerPending: false };
    peerConnectionsRef.current.set(peerId, remoteState);
    setRemotePeerIds((current) => Array.from(new Set([...current, peerId])));

    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, stream);
        applySenderQuality(sender, track.kind);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc-ice-candidate", {
          roomId,
          targetId: peerId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      const nextStream = event.streams[0] || remoteState.remoteStream;
      remoteState.remoteStream = nextStream;
      const video = remoteVideoRefs.current.get(peerId);
      if (video) {
        attachStream(video, nextStream);
      }
      setStatus("Live");
    };

    pc.onconnectionstatechange = () => {
      if (!peerConnectionsRef.current.has(peerId)) return;
      const connectionState = pc.connectionState;
      if (connectionState === "connected") {
        clearPeerReconnect(peerId);
        setStatus("Live");
      }
      if (["failed", "disconnected", "closed"].includes(connectionState)) {
        schedulePeerReconnect(peerId);
      }
    };

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") {
        const pending = remoteState.offerPending;
        remoteState.offerPending = false;
        if (pending && initiateOffer) {
          void startOffer(peerId, pc);
        }
      }
    };

    if (initiateOffer) {
      void startOffer(peerId, pc);
    }

    return pc;
  }

  async function startOffer(peerId, pc) {
    if (!socket || !roomId || !pc) return;
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      socket.emit("webrtc-offer", {
        roomId,
        targetId: peerId,
        sdp: pc.localDescription
      });
      setStatus("Connecting");
    } catch (error) {
      console.warn("Failed to create call offer", error);
      schedulePeerReconnect(peerId);
    }
  }

  async function receiveOffer(peerId, sdp) {
    if (!socket || !roomId || !peerId || !sdp) return;
    const pc = createPeerConnection(peerId, false);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc-answer", {
        roomId,
        targetId: peerId,
        sdp: pc.localDescription
      });
      setJoined(true);
      setStatus("Connecting");
    } catch (error) {
      console.warn("Failed to answer call offer", error);
      schedulePeerReconnect(peerId);
    }
  }

  async function receiveAnswer(peerId, sdp) {
    const remoteState = peerConnectionsRef.current.get(peerId);
    if (!remoteState || !sdp) return;
    const { pc } = remoteState;
    if (pc.signalingState === "have-local-offer") {
      try {
        await pc.setRemoteDescription(sdp);
        setJoined(true);
        setStatus("Live");
      } catch (error) {
        console.warn("Failed to apply call answer", error);
        schedulePeerReconnect(peerId);
      }
    }
  }

  async function receiveIce(peerId, candidate) {
    const remoteState = peerConnectionsRef.current.get(peerId);
    if (!remoteState || !candidate) return;
    try {
      await remoteState.pc.addIceCandidate(candidate);
    } catch (error) {
      console.error("Failed to add ICE candidate", error);
    }
  }

  function removePeer(peerId) {
    clearPeerReconnect(peerId);
    const remoteState = peerConnectionsRef.current.get(peerId);
    if (remoteState) {
      remoteState.pc.close();
      peerConnectionsRef.current.delete(peerId);
    }
    remoteVideoRefs.current.delete(peerId);
    setRemotePeerIds((current) => current.filter((id) => id !== peerId));
    setStatus((current) => (current === "Live" ? "Connecting" : current));
  }

  function clearPeerReconnect(peerId) {
    const timer = reconnectTimersRef.current.get(peerId);
    if (timer) clearTimeout(timer);
    reconnectTimersRef.current.delete(peerId);
  }

  function schedulePeerReconnect(peerId) {
    if (!socket || !roomId || !joinedCallRef.current || reconnectTimersRef.current.has(peerId)) return;
    setStatus("Reconnecting");
    const timer = setTimeout(() => {
      reconnectTimersRef.current.delete(peerId);
      const remoteState = peerConnectionsRef.current.get(peerId);
      if (remoteState) {
        remoteState.pc.close();
        peerConnectionsRef.current.delete(peerId);
      }
      socket.emit("join-call", { roomId, userName });
    }, 2000);
    reconnectTimersRef.current.set(peerId, timer);
  }

  function teardownCall() {
    const wasJoined = joinedCallRef.current;
    joinedCallRef.current = false;
    if (socket && wasJoined && roomId) {
      socket.emit("leave-call", { roomId });
    }

    peerConnectionsRef.current.forEach(({ pc }) => pc.close());
    peerConnectionsRef.current.clear();
    reconnectTimersRef.current.forEach((timer) => clearTimeout(timer));
    reconnectTimersRef.current.clear();
    remoteVideoRefs.current.clear();
    setRemotePeerIds([]);
    setJoined(false);

    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setLocalReady(false);
  }

  function broadcastPeerStatus() {
    if (!socket || !roomId) return;
    socket.emit("broadcast-peer-status", {
      roomId,
      micEnabled,
      cameraEnabled,
      userName
    });
  }

  async function startCameraAndMic() {
    if (!socket || !roomId) {
      setError("Call is not ready yet.");
      return;
    }

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError("Camera and microphone require a secure context. Open this app on https or localhost.");
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("This browser does not support camera and microphone access.");
      return;
    }

    setError("");
    setStatus("Requesting media");

    try {
      const quality = CALL_QUALITY[qualityMode] || CALL_QUALITY.high;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 48000 },
          channelCount: { ideal: 2 }
        },
        video: quality.video
      });

      localStreamRef.current = stream;
      setLocalReady(true);
      setMicEnabled(true);
      setCameraEnabled(true);
      attachStream(localVideoRef.current, stream);

      try {
        localStorage.setItem('ss-username', userName);
        localStorage.setItem('ss-call-quality', qualityMode);
      } catch { }

      socket.emit("join-call", { roomId, userName });
      joinedCallRef.current = true;
      setJoined(true);
      setStatus(hasTurnServer(peerConfig.iceServers || []) ? "Connecting with TURN" : "Connecting");

      // Broadcast initial status
      setTimeout(() => {
        broadcastPeerStatus();
      }, 500);
    } catch (mediaError) {
      console.error("Failed to start camera/mic", mediaError);
      if (mediaError?.name === "NotAllowedError" || mediaError?.name === "SecurityError") {
        setError("Permission denied. Allow camera and microphone in the browser site settings, then reload this page.");
      } else if (mediaError?.name === "NotFoundError") {
        setError("No camera or microphone device was found.");
      } else if (mediaError?.name === "NotReadableError") {
        setError("Camera or microphone is already in use by another app.");
      } else {
        setError(mediaError?.message || "Unable to access camera and microphone.");
      }
      setStatus("Idle");
    }
  }

  function toggleTrack(kind) {
    const stream = localStreamRef.current;
    if (!stream) return;
    const tracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
    const nextEnabled = kind === "audio" ? !micEnabled : !cameraEnabled;
    tracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    if (kind === "audio") {
      setMicEnabled(nextEnabled);
    } else {
      setCameraEnabled(nextEnabled);
    }

    // Broadcast status change immediately with updated values
    if (socket && roomId) {
      socket.emit("broadcast-peer-status", {
        roomId,
        micEnabled: kind === "audio" ? nextEnabled : micEnabled,
        cameraEnabled: kind === "video" ? nextEnabled : cameraEnabled,
        userName
      });
    }
  }

  async function changeQuality(nextMode) {
    setQualityMode(nextMode);
    try { localStorage.setItem("ss-call-quality", nextMode); } catch { }

    const stream = localStreamRef.current;
    if (!stream) return;

    const quality = CALL_QUALITY[nextMode] || CALL_QUALITY.high;
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack?.applyConstraints) {
      await videoTrack.applyConstraints(quality.video).catch(() => {});
    }

    peerConnectionsRef.current.forEach(({ pc }) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track) applySenderQuality(sender, sender.track.kind, nextMode);
      });
    });
    setStatus("Quality updated");
  }

  function applySenderQuality(sender, kind, mode = qualityMode) {
    const quality = CALL_QUALITY[mode] || CALL_QUALITY.high;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = kind === "video" ? quality.videoBitrate : quality.audioBitrate;
    sender.setParameters(parameters).catch(() => {});
  }

  const hasRemote = remotePeerIds.length > 0;

  const shellClass = fullscreen
    ? "space-y-4 rounded-lg border border-white/10 bg-black/40 p-4 backdrop-blur"
    : `panel rounded-xl p-4 ${compact ? "space-y-3" : "space-y-4"}`;

  if (fullscreen) {
    const activeRemotePeerIds = remotePeerIds.filter((peerId) => peerConnectionsRef.current.has(peerId));
    const hasCallParticipants = localReady || activeRemotePeerIds.length > 0;
    if (!hasCallParticipants) return null;

    return (
      <div className="flex h-full min-h-0 w-full items-center">
        <div className="flex max-h-full min-h-0 w-full flex-col gap-3 rounded-xl border border-neon/20 bg-black/55 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-neon/70">Call</p>
              <p className="text-xs text-white/55">{status}</p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-white/65">
              {activeRemotePeerIds.length + (localReady ? 1 : 0)}
            </span>
          </div>
          <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-1">
            {localReady && (
              <ParticipantTile
                name={userName || "You"}
                cameraOn={cameraEnabled}
                micOn={micEnabled}
                isActive={micEnabled}
                isLocal
                isHost={true}
                registerVideo={(element) => {
                  if (element) attachStream(element, localStreamRef.current);
                }}
              />
            )}
            {activeRemotePeerIds.map((peerId) => (
              <ParticipantTile
                key={peerId}
                name={remotePeerStatus.get(peerId)?.userName || "Guest"}
                cameraOn={remotePeerStatus.get(peerId)?.cameraEnabled ?? true}
                micOn={remotePeerStatus.get(peerId)?.micEnabled ?? true}
                isActive={remotePeerStatus.get(peerId)?.micEnabled ?? true}
                registerVideo={(element) => {
                  if (element) {
                    remoteVideoRefs.current.set(peerId, element);
                    const remoteState = peerConnectionsRef.current.get(peerId);
                    if (remoteState?.remoteStream) {
                      attachStream(element, remoteState.remoteStream);
                    }
                  }
                }}
              />
            ))}
          </div>
          {localReady && (
            <div className="grid shrink-0 grid-cols-3 gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-2">
              <button
                className={`min-h-10 rounded-lg px-2 py-2 text-xs font-semibold transition ${micEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/25 text-red-100 hover:bg-red-500/35"}`}
                onClick={() => toggleTrack("audio")}
                type="button"
              >
                {micEnabled ? "Mic On" : "Muted"}
              </button>
              <button
                className={`min-h-10 rounded-lg px-2 py-2 text-xs font-semibold transition ${cameraEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/25 text-red-100 hover:bg-red-500/35"}`}
                onClick={() => toggleTrack("video")}
                type="button"
              >
                {cameraEnabled ? "Cam On" : "Cam Off"}
              </button>
              <button
                className="min-h-10 rounded-lg border border-white/15 px-2 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10"
                onClick={teardownCall}
                type="button"
              >
                Leave
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-white/40">Call</p>
          <p className="text-sm text-white/70">{status}</p>
        </div>
        <div className="text-xs text-white/40">{joined ? "Connected" : "Standby"}</div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className={`grid gap-3 ${compact ? "grid-cols-1" : "grid-cols-1"}`}>
        <div className="space-y-2">
          <div className="rounded-lg border border-white/10 bg-black/35 p-3 backdrop-blur">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.2em] text-white/40">Your name</p>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Enter your name"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/90 placeholder-white/30 outline-none transition focus:border-white/40"
                />
              </div>
            </div>
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/30 p-1">
              {Object.entries(CALL_QUALITY).map(([key, quality]) => (
                <button
                  key={key}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${qualityMode === key ? "bg-neon text-black" : "text-white/55 hover:bg-white/10"}`}
                  onClick={() => changeQuality(key)}
                  type="button"
                >
                  {quality.label}
                </button>
              ))}
            </div>
            <div className="relative">
              {cameraEnabled ? (
                <video
                  ref={localVideoRef}
                  className={`w-full rounded-lg bg-black ${compact ? "h-36" : "h-44"} object-contain`}
                  autoPlay
                  playsInline
                  muted
                />
              ) : (
                <div className={`flex w-full items-center justify-center rounded-lg bg-white/5 ${compact ? "h-36" : "h-44"}`}>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-white/80">{userName || 'You'}</p>
                  </div>
                </div>
              )}
              <div className="absolute bottom-2 left-2 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/80 backdrop-blur">
                You
              </div>
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <span className={`h-2 w-2 rounded-full ${micEnabled ? 'bg-white' : 'bg-red-400'}`} />
                <span className={`text-[10px] ${micEnabled ? 'text-white/80' : 'text-red-400'}`}>
                  {micEnabled ? 'Mic' : 'Muted'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {hasRemote ? (
            remotePeerIds.map((peerId) => (
              <RemoteTile
                key={peerId}
                peerId={peerId}
                compact={compact}
                status={remotePeerStatus.get(peerId)}
                registerVideo={(element) => {
                  if (element) {
                    remoteVideoRefs.current.set(peerId, element);
                    const remoteState = peerConnectionsRef.current.get(peerId);
                    if (remoteState?.remoteStream) {
                      attachStream(element, remoteState.remoteStream);
                    }
                  }
                }}
              />
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-white/10 p-4 text-center text-xs text-white/40">
              Waiting for other participants...
            </div>
          )}
        </div>
      </div>

      {!localReady ? (
        <button
          className="w-full rounded-lg bg-neon px-3 py-2 font-semibold text-black transition hover:bg-neon/90 disabled:opacity-50"
          onClick={startCameraAndMic}
          disabled={!socket || !roomId || !userName.trim()}
        >
          Join Call
        </button>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <button
          className={`rounded-lg px-3 py-2 text-sm transition ${micEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/20 text-red-200 hover:bg-red-500/30"}`}
          onClick={() => toggleTrack("audio")}
          disabled={!localReady}
        >
          {micEnabled ? "Mic On" : "Mic Off"}
        </button>
        <button
          className={`rounded-lg px-3 py-2 text-sm transition ${cameraEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/20 text-red-200 hover:bg-red-500/30"}`}
          onClick={() => toggleTrack("video")}
          disabled={!localReady}
        >
          {cameraEnabled ? "Camera On" : "Camera Off"}
        </button>
      </div>

      {localReady && (
        <button
          className="w-full rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 transition hover:bg-white/5"
          onClick={teardownCall}
        >
          Leave Call
        </button>
      )}
    </div>
  );
}

function RemoteTile({ peerId, compact, status, registerVideo, fullscreen = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    registerVideo(videoRef.current);
  }, [registerVideo]);

  const cameraOn = status?.cameraEnabled ?? true;
  const micOn = status?.micEnabled ?? true;
  const name = status?.userName || 'Guest';

  const tileClass = fullscreen
    ? `relative rounded-lg border ${micOn ? "border-neon/60" : "border-white/10"} bg-black/40 p-2 backdrop-blur shadow-[0_10px_30px_rgba(0,0,0,0.45)]`
    : "rounded-lg border border-white/10 bg-black/45 p-2";

  return (
    <div className={tileClass}>
      <div className="relative">
        {cameraOn ? (
          <video
            ref={videoRef}
            className={`w-full rounded-lg bg-black ${compact ? "h-36" : "h-44"} object-contain`}
            autoPlay
            playsInline
          />
        ) : (
          <div className={`flex w-full items-center justify-center rounded-lg bg-white/5 ${compact ? "h-36" : "h-44"}`}>
            <div className="text-center">
              <p className="text-sm font-semibold text-white/80">{name}</p>
            </div>
          </div>
        )}
        <div className="absolute bottom-2 left-2 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/80 backdrop-blur">
          {name}
        </div>
        <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/70 backdrop-blur">
          <span className={`h-2 w-2 rounded-full ${micOn ? 'bg-white' : 'bg-red-400'}`} />
          <span>{micOn ? 'Mic' : 'Muted'}</span>
        </div>
      </div>
    </div>
  );
}

function ParticipantTile({ name, cameraOn, micOn, isActive, isLocal = false, registerVideo = (_element) => {}, isHost = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (registerVideo) registerVideo(videoRef.current);
  }, [registerVideo]);

  return (
    <div className={`group relative aspect-video w-full overflow-hidden rounded-lg border ${isActive ? "border-neon/60" : "border-white/10"} bg-[#121212]/80 shadow-2xl transition-all duration-300`}>
      {cameraOn ? (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
          autoPlay
          playsInline
          muted={isLocal}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[#111111]">
          <div className="text-sm font-semibold text-white/40">{name}</div>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-between">
        <span className="text-[11px] font-bold tracking-wide text-white/90 drop-shadow-md truncate max-w-[70%]">
          {name} {isLocal && "(You)"}
        </span>
        <div className="flex items-center gap-1.5 rounded-md border border-white/5 bg-black/20 px-1.5 py-0.5 backdrop-blur-md">
          <div className={`h-1.5 w-1.5 rounded-full ${micOn ? "bg-neon" : "bg-red-500"}`} />
          <div className="flex flex-col gap-0.5">
            <div className={`h-2.5 w-0.5 rounded-full ${micOn ? "bg-neon" : "bg-white/20"}`} />
            <div className={`h-1.5 w-0.5 rounded-full ${micOn ? "bg-neon" : "bg-white/20"}`} />
          </div>
        </div>
      </div>

      {isHost && (
        <div className="absolute right-2 top-2 rounded-md bg-neon px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-black">
          Host
        </div>
      )}
    </div>
  );
}
