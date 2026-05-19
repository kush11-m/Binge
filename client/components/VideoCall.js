import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function attachStream(videoElement, stream) {
  if (!videoElement) return;
  if (videoElement.srcObject !== stream) {
    videoElement.srcObject = stream;
  }
}

export default function VideoCall({ socket, roomId, compact = false, fullscreen = false }) {
  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef(new Map());
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const joinedCallRef = useRef(false);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState("Idle");
  const [joined, setJoined] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [remotePeerIds, setRemotePeerIds] = useState([]);
  const [error, setError] = useState("");
  const [userName, setUserName] = useState(() => {
    try { return localStorage.getItem('ss-username') || ''; } catch { return ''; }
  });
  const [remotePeerStatus, setRemotePeerStatus] = useState(new Map());

  const peerConfig = useMemo(
    () => ({
      iceServers: DEFAULT_ICE_SERVERS,
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
    if (!socket || !roomId) return;

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

    return () => {
      socket.off("call-peers", handleCallPeers);
      socket.off("call-peer-joined", handlePeerJoined);
      socket.off("call-peer-left", handlePeerLeft);
      socket.off("webrtc-offer", handleOffer);
      socket.off("webrtc-answer", handleAnswer);
      socket.off("webrtc-ice-candidate", handleIce);
      socket.off("peer-status", handlePeerStatus);
    };
  }, [socket, roomId]);

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
        pc.addTrack(track, stream);
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
      const connectionState = pc.connectionState;
      if (connectionState === "connected") {
        setStatus("Live");
      }
      if (["failed", "disconnected", "closed"].includes(connectionState)) {
        removePeer(peerId);
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
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", {
      roomId,
      targetId: peerId,
      sdp: pc.localDescription
    });
    setStatus("Connecting");
  }

  async function receiveOffer(peerId, sdp) {
    if (!socket || !roomId || !peerId || !sdp) return;
    const pc = createPeerConnection(peerId, false);
    if (!pc) return;

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
  }

  async function receiveAnswer(peerId, sdp) {
    const remoteState = peerConnectionsRef.current.get(peerId);
    if (!remoteState || !sdp) return;
    const { pc } = remoteState;
    if (pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(sdp);
      setJoined(true);
      setStatus("Live");
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
    const remoteState = peerConnectionsRef.current.get(peerId);
    if (remoteState) {
      remoteState.pc.close();
      peerConnectionsRef.current.delete(peerId);
    }
    remoteVideoRefs.current.delete(peerId);
    setRemotePeerIds((current) => current.filter((id) => id !== peerId));
    setStatus((current) => (current === "Live" ? "Connecting" : current));
  }

  function teardownCall() {
    if (socket && joinedCallRef.current && roomId) {
      socket.emit("leave-call", { roomId });
    }

    peerConnectionsRef.current.forEach(({ pc }) => pc.close());
    peerConnectionsRef.current.clear();
    remoteVideoRefs.current.clear();
    setRemotePeerIds([]);
    setJoined(false);
    joinedCallRef.current = false;

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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      });

      localStreamRef.current = stream;
      setLocalReady(true);
      setMicEnabled(true);
      setCameraEnabled(true);
      attachStream(localVideoRef.current, stream);

      try { localStorage.setItem('ss-username', userName); } catch {}

      socket.emit("join-call", { roomId, userName });
      joinedCallRef.current = true;
      setJoined(true);
      setStatus("Connecting");
      
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

  const hasRemote = remotePeerIds.length > 0;

  const shellClass = fullscreen
    ? "space-y-4 rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur"
    : `panel rounded-xl p-4 ${compact ? "space-y-3" : "space-y-4"}`;

  if (fullscreen) {
    const slotCount = 4;
    const remoteSlots = remotePeerIds.slice(0, slotCount - 1);
    const placeholders = Math.max(0, slotCount - (remoteSlots.length + 1));

    return (
      <div className="h-full w-full rounded-2xl border border-white/10 bg-black/20 p-3 backdrop-blur-xl">
        <div className="flex h-full flex-col justify-center gap-4">
          <ParticipantTile
            name={userName || "You"}
            cameraOn={cameraEnabled}
            micOn={micEnabled}
            isActive={micEnabled}
            isLocal
            registerVideo={(element) => {
              if (element) attachStream(element, localStreamRef.current);
            }}
          />
          {remoteSlots.map((peerId) => (
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
          {Array.from({ length: placeholders }).map((_, index) => (
            <ParticipantTile
              key={`placeholder-${index}`}
              name="Waiting"
              cameraOn={false}
              micOn={false}
              isActive={false}
              placeholder
            />
          ))}
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
          <div className="rounded-2xl border border-white/10 bg-black/40 p-3 backdrop-blur">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.2em] text-white/40">Your name</p>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Enter your name"
                  className="mt-1 w-full rounded-full border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/90 placeholder-white/30 outline-none transition focus:border-[#39FF88]"
                />
              </div>
            </div>
            <div className="relative">
              {cameraEnabled ? (
                <video
                  ref={localVideoRef}
                  className={`w-full rounded-2xl bg-black ${compact ? "h-32" : "h-40"} object-cover`}
                  autoPlay
                  playsInline
                  muted
                />
              ) : (
                <div className={`w-full rounded-2xl bg-gradient-to-br from-[#39FF88]/20 to-black flex items-center justify-center ${compact ? "h-32" : "h-40"}`}>
                  <div className="text-center">
                    <div className="text-2xl mb-2">🎥</div>
                    <p className="text-sm font-semibold text-[#39FF88]">{userName || 'You'}</p>
                  </div>
                </div>
              )}
              <div className="absolute bottom-2 left-2 rounded-full border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/80 backdrop-blur">
                You
              </div>
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <span className={`h-2 w-2 rounded-full ${micEnabled ? 'bg-[#39FF88]' : 'bg-red-400'}`} />
                <span className={`text-[10px] ${micEnabled ? 'text-[#39FF88]' : 'text-red-400'}`}>
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
            <div className="rounded-2xl border border-dashed border-white/10 p-4 text-center text-xs text-white/40">
              Waiting for other participants...
            </div>
          )}
        </div>
      </div>

      {!localReady ? (
        <button
          className="w-full rounded-full bg-[#39FF88] px-3 py-2 font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
          onClick={startCameraAndMic}
          disabled={!socket || !roomId || !userName.trim()}
        >
          Join Call
        </button>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <button
          className={`rounded-full px-3 py-2 text-sm transition ${micEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/20 text-red-200 hover:bg-red-500/30"}`}
          onClick={() => toggleTrack("audio")}
          disabled={!localReady}
        >
          {micEnabled ? "Mic On" : "Mic Off"}
        </button>
        <button
          className={`rounded-full px-3 py-2 text-sm transition ${cameraEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/20 text-red-200 hover:bg-red-500/30"}`}
          onClick={() => toggleTrack("video")}
          disabled={!localReady}
        >
          {cameraEnabled ? "Camera On" : "Camera Off"}
        </button>
      </div>

      {localReady && (
        <button
          className="w-full rounded-full border border-white/15 px-3 py-2 text-sm text-white/80 transition hover:bg-white/5"
          onClick={teardownCall}
        >
          Leave Call
        </button>
      )}
    </div>
  );
}

function RemoteTile({ peerId, compact, status, registerVideo, fullscreen }) {
  const videoRef = useRef(null);

  useEffect(() => {
    registerVideo(videoRef.current);
  }, [registerVideo]);

  const cameraOn = status?.cameraEnabled ?? true;
  const micOn = status?.micEnabled ?? true;
  const name = status?.userName || 'Guest';

  const tileClass = fullscreen
    ? `relative rounded-2xl border ${micOn ? "border-[#39FF88]/60" : "border-white/10"} bg-black/40 p-2 backdrop-blur shadow-[0_10px_30px_rgba(0,0,0,0.45)]`
    : "rounded-xl bg-black/60 p-2";

  return (
    <div className={tileClass}>
      <div className="relative">
        {cameraOn ? (
          <video
            ref={videoRef}
            className={`w-full rounded-2xl bg-black ${compact ? "h-32" : "h-40"} object-cover`}
            autoPlay
            playsInline
          />
        ) : (
          <div className={`w-full rounded-2xl bg-gradient-to-br from-[#39FF88]/20 to-black flex items-center justify-center ${compact ? "h-32" : "h-40"}`}>
            <div className="text-center">
              <div className="text-2xl mb-2">👤</div>
              <p className="text-sm font-semibold text-[#39FF88]">{name}</p>
            </div>
          </div>
        )}
        <div className="absolute bottom-2 left-2 rounded-full border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/80 backdrop-blur">
          {name}
        </div>
        <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/70 backdrop-blur">
          <span className={`h-2 w-2 rounded-full ${micOn ? 'bg-[#39FF88]' : 'bg-red-400'}`} />
          <span>{micOn ? 'Mic' : 'Muted'}</span>
        </div>
      </div>
    </div>
  );
}

function ParticipantTile({ name, cameraOn, micOn, isActive, isLocal = false, registerVideo, placeholder = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (registerVideo) registerVideo(videoRef.current);
  }, [registerVideo]);

  return (
    <div className={`group relative w-full overflow-hidden rounded-2xl border ${isActive ? "border-[#39FF88]/70 shadow-[0_0_18px_rgba(57,255,136,0.35)]" : "border-white/10"} bg-black/40 transition duration-300 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(57,255,136,0.2)] aspect-[3/4]`}>
      {cameraOn ? (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          playsInline
          muted={isLocal}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#39FF88]/15 to-black">
          {!placeholder && <div className="text-sm font-semibold text-[#39FF88]">{name}</div>}
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/80 to-transparent" />
      <div className="absolute bottom-2 left-2 text-xs text-white/80">{name}</div>
      <div className="absolute bottom-2 right-2 flex items-end gap-1">
        <span className={`h-2 w-1 rounded-full ${micOn ? "bg-[#39FF88]" : "bg-white/20"} animate-pulse`} />
        <span className={`h-4 w-1 rounded-full ${micOn ? "bg-[#39FF88]" : "bg-white/20"} animate-pulse`} style={{ animationDelay: '0.15s' }} />
        <span className={`h-3 w-1 rounded-full ${micOn ? "bg-[#39FF88]" : "bg-white/20"} animate-pulse`} style={{ animationDelay: '0.3s' }} />
      </div>
    </div>
  );
}
