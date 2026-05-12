import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function attachStream(videoElement, stream) {
  if (!videoElement) return;
  if (videoElement.srcObject !== stream) {
    videoElement.srcObject = stream;
  }
}

export default function VideoCall({ socket, roomId, compact = false }) {
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

  useEffect(() => {
    attachStream(localVideoRef.current, localStreamRef.current);
  }, [localReady]);

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

    socket.on("call-peers", handleCallPeers);
    socket.on("call-peer-joined", handlePeerJoined);
    socket.on("call-peer-left", handlePeerLeft);
    socket.on("webrtc-offer", handleOffer);
    socket.on("webrtc-answer", handleAnswer);
    socket.on("webrtc-ice-candidate", handleIce);

    return () => {
      socket.off("call-peers", handleCallPeers);
      socket.off("call-peer-joined", handlePeerJoined);
      socket.off("call-peer-left", handlePeerLeft);
      socket.off("webrtc-offer", handleOffer);
      socket.off("webrtc-answer", handleAnswer);
      socket.off("webrtc-ice-candidate", handleIce);
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

      socket.emit("join-call", { roomId });
      joinedCallRef.current = true;
      setJoined(true);
      setStatus("Connecting");
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
  }

  const hasRemote = remotePeerIds.length > 0;

  return (
    <div className={`panel rounded-xl p-4 ${compact ? "space-y-3" : "space-y-4"}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-white/40">Call</p>
          <p className="text-sm text-white/70">{status}</p>
        </div>
        <div className="text-xs text-white/40">{joined ? "Connected" : "Standby"}</div>
      </div>

      {!localReady ? (
        <button
          className="w-full rounded-xl bg-neon px-3 py-2 font-semibold text-black transition hover:opacity-90"
          onClick={startCameraAndMic}
          disabled={!socket || !roomId}
        >
          Enable Camera & Mic
        </button>
      ) : null}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className={`grid gap-3 ${compact ? "grid-cols-1" : "grid-cols-1"}`}>
        <div className="space-y-2">
          <div className="rounded-xl bg-black/60 p-2">
            <video
              ref={localVideoRef}
              className={`w-full rounded-lg bg-black ${compact ? "h-32" : "h-40"} object-cover`}
              autoPlay
              playsInline
              muted
            />
            <p className="mt-2 text-xs uppercase tracking-[0.2em] text-white/40">You</p>
          </div>
        </div>

        <div className="space-y-2">
          {hasRemote ? (
            remotePeerIds.map((peerId) => (
              <RemoteTile
                key={peerId}
                peerId={peerId}
                compact={compact}
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
            <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-white/40">
              Remote viewer preview appears here.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className={`rounded-xl px-3 py-2 text-sm transition ${micEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/20 text-red-200 hover:bg-red-500/30"}`}
          onClick={() => toggleTrack("audio")}
          disabled={!localReady}
        >
          {micEnabled ? "Mic On" : "Mic Off"}
        </button>
        <button
          className={`rounded-xl px-3 py-2 text-sm transition ${cameraEnabled ? "bg-white/10 text-white hover:bg-white/15" : "bg-red-500/20 text-red-200 hover:bg-red-500/30"}`}
          onClick={() => toggleTrack("video")}
          disabled={!localReady}
        >
          {cameraEnabled ? "Camera On" : "Camera Off"}
        </button>
      </div>

      {localReady && (
        <button
          className="w-full rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80 transition hover:bg-white/5"
          onClick={teardownCall}
        >
          Leave Call
        </button>
      )}
    </div>
  );
}

function RemoteTile({ peerId, compact, registerVideo }) {
  const videoRef = useRef(null);

  useEffect(() => {
    registerVideo(videoRef.current);
  }, [registerVideo]);

  return (
    <div className="rounded-xl bg-black/60 p-2">
      <video
        ref={videoRef}
        className={`w-full rounded-lg bg-black ${compact ? "h-32" : "h-40"} object-cover`}
        autoPlay
        playsInline
      />
      <p className="mt-2 text-xs uppercase tracking-[0.2em] text-white/40">Peer {peerId.slice(0, 6)}</p>
    </div>
  );
}
