import type { Socket } from "socket.io-client";
import { StreamingProvider } from "./StreamingProvider";
import { getIceServers, hasTurnServer } from "../services/iceServers";
import { formatRelayBitrate, getRelayVideoBitrate } from "../services/streamQuality";

type PeerState = {
  pc: RTCPeerConnection;
  stream?: MediaStream;
  statsTimer?: ReturnType<typeof setInterval>;
  lastBytes?: number;
  lastTimestamp?: number;
};

export class WebRTCProvider extends StreamingProvider {
  private peers = new Map<string, PeerState>();
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private attachedVideo: HTMLVideoElement | null = null;
  private handlers: Array<[string, (...args: any[]) => void]> = [];
  private viewerFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private viewerRetryTimer: ReturnType<typeof setInterval> | null = null;
  private hostCaptureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly iceServers = getIceServers();
  private readonly relayVideoBitrate = getRelayVideoBitrate();

  constructor(
    private socket: Socket,
    private roomId: string,
    private isHost: boolean,
    private hostId: string | null,
    private serverBase: string,
    private fallbackVideoUrl: string
  ) {
    super();
    this.bindSocket();
    this.setStatus({
      label: isHost ? "Internet relay ready" : "Finding host",
      detail: isHost
        ? hasTurnServer(this.iceServers)
          ? "TURN relay configured for restrictive networks"
          : `Using public STUN at up to ${formatRelayBitrate(this.relayVideoBitrate)}; add TURN for stricter networks`
        : "Waiting for the host stream",
      quality: hasTurnServer(this.iceServers) ? "WebRTC + TURN" : "WebRTC"
    });
  }

  async attach(video: HTMLVideoElement) {
    this.attachedVideo = video;
    if (this.isHost) {
      await this.attachHost(video);
      return;
    }

    if (this.remoteStream) {
      video.srcObject = this.remoteStream;
      return;
    }

    if (this.hasServerFallback() && !video.src) {
      video.src = `${this.serverBase}${this.fallbackVideoUrl}`;
    }

    this.armViewerFallback();
    this.startViewerRetry();
  }

  destroy() {
    this.handlers.forEach(([event, handler]) => this.socket.off(event, handler));
    this.handlers = [];
    if (this.viewerFallbackTimer) clearTimeout(this.viewerFallbackTimer);
    if (this.viewerRetryTimer) clearInterval(this.viewerRetryTimer);
    if (this.hostCaptureRetryTimer) clearTimeout(this.hostCaptureRetryTimer);
    this.peers.forEach((peer) => {
      if (peer.statsTimer) clearInterval(peer.statsTimer);
      peer.pc.close();
    });
    this.peers.clear();
    this.localStream = null;
    this.remoteStream = null;
    this.attachedVideo = null;
  }

  private async attachHost(video: HTMLVideoElement) {
    const fallbackSource = this.hasServerFallback() ? `${this.serverBase}${this.fallbackVideoUrl}` : "";
    if (fallbackSource && !video.src) {
      video.src = fallbackSource;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
    }

    const videoWithCapture = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const capture = videoWithCapture.captureStream || videoWithCapture.mozCaptureStream;
    if (capture && !this.localStream) {
      if (!video.src && !video.srcObject) {
        this.setStatus({
          label: "Choose local source",
          detail: "This internet room is waiting for the host's local video file",
          quality: "P2P source",
          transport: "WebRTC"
        });
        return;
      }

      await this.waitForHostSource(video);
      if (!this.attachedVideo) return;

      const nextStream = capture.call(video);
      if (!nextStream.getTracks().length) {
        this.setStatus({
          label: "Loading local source",
          detail: "Waiting for the browser to expose video tracks for the P2P relay",
          quality: "P2P source",
          transport: "WebRTC"
        });
        this.hostCaptureRetryTimer = setTimeout(() => {
          this.hostCaptureRetryTimer = null;
          void this.attachHost(video);
        }, 500);
        return;
      }

      this.localStream = nextStream;
      this.localStream.addEventListener("addtrack", () => {
        this.peers.forEach(({ pc }) => this.addTracks(pc));
      });
      this.peers.forEach(({ pc }) => this.addTracks(pc));
      this.socket.emit("internet-host-ready", { roomId: this.roomId });
      this.setStatus({
        label: "Internet live",
        detail: `Relaying this player through WebRTC at up to ${formatRelayBitrate(this.relayVideoBitrate)}`,
        quality: hasTurnServer(this.iceServers) ? "WebRTC + TURN" : "WebRTC",
        transport: hasTurnServer(this.iceServers) ? "TURN" : "WebRTC"
      });
    } else if (!capture) {
      this.setStatus({
        label: this.hasServerFallback() ? "Internet fallback" : "Unsupported browser",
        detail: this.hasServerFallback()
          ? "This browser cannot capture the video element, using server media URL"
          : "This browser cannot capture the video element for a free P2P room",
        quality: this.hasServerFallback() ? "HTTP fallback" : "P2P unavailable",
        transport: this.hasServerFallback() ? "HTTP" : "WebRTC"
      });
    }
  }

  private waitForHostSource(video: HTMLVideoElement) {
    if (video.readyState >= 1 || video.srcObject) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("error", onReady);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(onReady, 3000);
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("canplay", onReady, { once: true });
      video.addEventListener("error", onReady, { once: true });
    });
  }

  private bindSocket() {
    this.on("internet-viewer-request", ({ roomId, viewerId }) => {
      if (!this.isHost || roomId !== this.roomId || !viewerId) return;
      const pc = this.ensurePeer(viewerId);
      void this.createOffer(viewerId, pc);
    });

    this.on("internet-host-ready", ({ roomId, hostId }) => {
      if (this.isHost || roomId !== this.roomId) return;
      this.hostId = hostId;
      this.socket.emit("internet-viewer-request", { roomId: this.roomId, hostId });
      this.armViewerFallback();
      this.startViewerRetry();
    });

    this.on("internet-offer", ({ roomId, fromId, sdp }) => {
      if (roomId !== this.roomId || this.isHost || !fromId || !sdp) return;
      void this.receiveOffer(fromId, sdp);
    });

    this.on("internet-answer", ({ roomId, fromId, sdp }) => {
      if (roomId !== this.roomId || !this.isHost || !fromId || !sdp) return;
      void this.receiveAnswer(fromId, sdp);
    });

    this.on("internet-ice-candidate", ({ roomId, fromId, candidate }) => {
      if (roomId !== this.roomId || !fromId || !candidate) return;
      void this.receiveIce(fromId, candidate);
    });

    if (!this.isHost) {
      this.socket.emit("internet-viewer-request", {
        roomId: this.roomId,
        hostId: this.hostId
      });
      this.startViewerRetry();
    }
  }

  private on(event: string, handler: (...args: any[]) => void) {
    this.socket.on(event, handler);
    this.handlers.push([event, handler]);
  }

  private ensurePeer(peerId: string) {
    const existing = this.peers.get(peerId);
    if (existing) return existing.pc;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.socket.emit("internet-ice-candidate", {
        roomId: this.roomId,
        targetId: peerId,
        candidate: event.candidate
      });
    };

    pc.ontrack = (event) => {
      this.remoteStream = event.streams[0];
      if (this.viewerFallbackTimer) clearTimeout(this.viewerFallbackTimer);
      if (this.viewerRetryTimer) clearInterval(this.viewerRetryTimer);
      this.viewerRetryTimer = null;
      this.dispatchEvent(new CustomEvent("remote-stream", { detail: this.remoteStream }));
      this.setStatus({
        label: "Internet live",
        detail: "Receiving the host player through WebRTC",
        quality: hasTurnServer(this.iceServers) ? "WebRTC + TURN" : "WebRTC",
        transport: hasTurnServer(this.iceServers) ? "TURN" : "WebRTC"
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        if (this.viewerFallbackTimer) clearTimeout(this.viewerFallbackTimer);
        this.setStatus({
          label: "Internet live",
          detail: "Peer connection established",
          quality: hasTurnServer(this.iceServers) ? "WebRTC + TURN" : "WebRTC",
          transport: hasTurnServer(this.iceServers) ? "TURN" : "WebRTC"
        });
        this.startStats(peerId);
      }
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        const peer = this.peers.get(peerId);
        if (peer?.statsTimer) clearInterval(peer.statsTimer);
        this.peers.delete(peerId);
        if (!this.isHost) {
          this.useServerFallback("Peer connection dropped; continuing with the server media URL");
          this.startViewerRetry();
        }
      }
    };

    this.peers.set(peerId, { pc });
    this.addTracks(pc);
    return pc;
  }

  private addTracks(pc: RTCPeerConnection) {
    if (!this.localStream) return;
    const existingTrackIds = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
    this.localStream.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) {
        const sender = pc.addTrack(track, this.localStream as MediaStream);
        if (track.kind === "video") {
          const parameters = sender.getParameters();
          parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
          parameters.encodings[0].maxBitrate = this.relayVideoBitrate;
          sender.setParameters(parameters).catch(() => {});
        }
      }
    });
  }

  private async createOffer(peerId: string, pc: RTCPeerConnection) {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      this.socket.emit("internet-offer", {
        roomId: this.roomId,
        targetId: peerId,
        sdp: pc.localDescription
      });
    } catch (error) {
      console.warn("Unable to create internet offer", error);
      this.setStatus({
        label: "Internet relay waiting",
        detail: this.hasServerFallback()
          ? "Unable to start a peer relay yet; viewers can use server media fallback"
          : "Unable to start a peer relay yet; retrying the direct host connection",
        quality: this.hasServerFallback() ? "HTTP fallback" : "P2P only",
        transport: this.hasServerFallback() ? "HTTP" : "WebRTC"
      });
    }
  }

  private async receiveOffer(peerId: string, sdp: RTCSessionDescriptionInit) {
    try {
      const pc = this.ensurePeer(peerId);
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit("internet-answer", {
        roomId: this.roomId,
        targetId: peerId,
        sdp: pc.localDescription
      });
    } catch (error) {
      console.warn("Unable to answer internet offer", error);
      if (!this.isHost) {
        this.useServerFallback("Unable to answer WebRTC offer; using server media URL");
      }
    }
  }

  private async receiveAnswer(peerId: string, sdp: RTCSessionDescriptionInit) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc.signalingState !== "have-local-offer") return;
    try {
      await peer.pc.setRemoteDescription(sdp);
    } catch (error) {
      console.warn("Unable to apply internet answer", error);
    }
  }

  private async receiveIce(peerId: string, candidate: RTCIceCandidateInit) {
    const pc = this.ensurePeer(peerId);
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("Unable to add internet ICE candidate", error);
    }
  }

  private armViewerFallback() {
    if (this.isHost || this.remoteStream || this.viewerFallbackTimer) return;
    this.viewerFallbackTimer = setTimeout(() => {
      if (this.remoteStream) return;
      this.useServerFallback(hasTurnServer(this.iceServers)
        ? "Waiting for WebRTC"
        : "Add a TURN server for better NAT traversal");
    }, 8000);
  }

  private startViewerRetry() {
    if (this.isHost || this.remoteStream || this.viewerRetryTimer) return;
    this.viewerRetryTimer = setInterval(() => {
      if (this.remoteStream) {
        if (this.viewerRetryTimer) clearInterval(this.viewerRetryTimer);
        this.viewerRetryTimer = null;
        return;
      }

      this.socket.emit("internet-viewer-request", {
        roomId: this.roomId,
        hostId: this.hostId
      });
    }, 6000);
  }

  private useServerFallback(detail: string) {
    if (!this.hasServerFallback()) {
      this.setStatus({
        label: "Waiting for host",
        detail: "This free room has no server media fallback; keep the host tab open and connected",
        quality: "P2P only",
        transport: "WebRTC"
      });
      return;
    }

    const fallbackSource = `${this.serverBase}${this.fallbackVideoUrl}`;
    if (this.attachedVideo) {
      const resumeAt = Number.isFinite(this.attachedVideo.currentTime)
        ? this.attachedVideo.currentTime
        : 0;
      const shouldResume = !this.attachedVideo.paused && !this.attachedVideo.ended;

      this.attachedVideo.srcObject = null;
      if (this.attachedVideo.src !== fallbackSource) {
        const restorePlaybackPosition = () => {
          if (!this.attachedVideo || !Number.isFinite(resumeAt) || resumeAt <= 0) return;
          const duration = this.attachedVideo.duration;
          const safeTime = Number.isFinite(duration) && duration > 0
            ? Math.min(resumeAt, Math.max(duration - 0.25, 0))
            : resumeAt;
          try {
            this.attachedVideo.currentTime = safeTime;
          } catch (_error) {
            // Some browsers reject seeks before enough metadata is available.
          }
        };

        this.attachedVideo.addEventListener("loadedmetadata", restorePlaybackPosition, { once: true });
        this.attachedVideo.src = fallbackSource;
        this.attachedVideo.preload = "auto";
        this.attachedVideo.crossOrigin = "anonymous";
      }

      if (shouldResume) {
        this.attachedVideo.play().catch(() => {});
      }
    }

    this.setStatus({
      label: "Internet fallback",
      detail: `${detail}. Playback position is preserved while the relay retries in the background.`,
      quality: "HTTP fallback",
      transport: "HTTP"
    });
  }

  private hasServerFallback() {
    return typeof this.fallbackVideoUrl === "string" && this.fallbackVideoUrl.startsWith("/");
  }

  private startStats(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.statsTimer) return;

    peer.statsTimer = setInterval(() => {
      void this.collectStats(peerId);
    }, 2000);
    void this.collectStats(peerId);
  }

  private async collectStats(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    try {
      const report = await peer.pc.getStats();
      let selectedCandidatePairId: string | undefined;
      let bitrateKbps: number | undefined;
      let frameWidth: number | undefined;
      let frameHeight: number | undefined;
      let framesPerSecond: number | undefined;
      let packetsLost: number | undefined;
      let packetsReceived: number | undefined;
      let roundTripMs: number | undefined;

      report.forEach((stat: any) => {
        if (stat.type === "transport" && stat.selectedCandidatePairId) {
          selectedCandidatePairId = stat.selectedCandidatePairId;
        }

        const mediaStat = this.isHost ? stat.type === "outbound-rtp" : stat.type === "inbound-rtp";
        if (mediaStat && stat.kind === "video") {
          const bytes = this.isHost ? stat.bytesSent : stat.bytesReceived;
          if (typeof bytes === "number" && typeof stat.timestamp === "number" && peer.lastBytes != null && peer.lastTimestamp != null) {
            const bytesDelta = bytes - peer.lastBytes;
            const msDelta = stat.timestamp - peer.lastTimestamp;
            if (bytesDelta >= 0 && msDelta > 0) {
              bitrateKbps = Math.round((bytesDelta * 8) / msDelta);
            }
          }
          if (typeof bytes === "number") peer.lastBytes = bytes;
          if (typeof stat.timestamp === "number") peer.lastTimestamp = stat.timestamp;

          frameWidth = stat.frameWidth || frameWidth;
          frameHeight = stat.frameHeight || frameHeight;
          framesPerSecond = stat.framesPerSecond || stat.framesEncodedPerSecond || framesPerSecond;
          packetsLost = stat.packetsLost ?? packetsLost;
          packetsReceived = stat.packetsReceived ?? packetsReceived;
        }
      });

      const selectedPair = selectedCandidatePairId ? report.get(selectedCandidatePairId) : undefined;
      if (selectedPair?.currentRoundTripTime != null) {
        roundTripMs = Math.round(selectedPair.currentRoundTripTime * 1000);
      }

      let packetLossPct: number | undefined;
      if (typeof packetsLost === "number" && typeof packetsReceived === "number") {
        const total = packetsLost + packetsReceived;
        if (total > 0) packetLossPct = Math.round((packetsLost / total) * 1000) / 10;
      }

      this.setStatus({
        ...this.status,
        bitrateKbps: bitrateKbps ?? this.status.bitrateKbps,
        roundTripMs: roundTripMs ?? this.status.roundTripMs,
        packetLossPct: packetLossPct ?? this.status.packetLossPct,
        frameWidth: frameWidth ?? this.status.frameWidth,
        frameHeight: frameHeight ?? this.status.frameHeight,
        framesPerSecond: framesPerSecond ?? this.status.framesPerSecond
      });
    } catch (error) {
      console.warn("Unable to read WebRTC stats", error);
    }
  }
}
