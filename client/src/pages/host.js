import Head from "next/head";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { nanoid } from "nanoid";
import UploadPanel from "../components/UploadPanel";
import { useServerDiagnostics } from "../hooks/useServerDiagnostics";
import { useNetworkCandidates } from "../hooks/useNetworkCandidates";
import { buildRoomPath, getDefaultServerBase, isLocalHostname, normalizeServerBase } from "../services/connection";
import { saveLocalMedia } from "../services/localMediaStore";
import { formatBytes, validateMediaSelection } from "../services/mediaLimits";

function uploadRoom({ serverBase, roomId, mode, videoFile, subsFile, onProgress }) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("roomId", roomId);
    formData.append("mode", mode);
    formData.append("video", videoFile);
    if (subsFile) formData.append("subs", subsFile);

    const request = new XMLHttpRequest();
    request.open("POST", `${serverBase}/upload`);
    request.responseType = "json";

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };

    request.onload = () => {
      const payload = request.response || {};
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve(payload);
        return;
      }
      reject(new Error(payload.error || `Upload failed with ${request.status}`));
    };

    request.onerror = () => reject(new Error("Upload server is unreachable."));
    request.onabort = () => reject(new Error("Upload was cancelled."));
    request.send(formData);
  });
}

async function preparePeerRoom({ serverBase, roomId, videoFile, subsFile }) {
  const payload = {
    roomId,
    videoName: videoFile.name,
    videoSize: videoFile.size,
    videoType: videoFile.type,
    subsName: subsFile?.name || "",
    subsText: subsFile ? await subsFile.text() : ""
  };

  const response = await fetch(`${serverBase}/upload/p2p`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Room prepare failed with ${response.status}`);
  return body;
}

export default function Host() {
  const router = useRouter();
  const mode = router.query.mode === "INTERNET" ? "INTERNET" : "LAN";
  const [roomId, setRoomId] = useState("");
  const [serverBase, setServerBase] = useState("");
  const [origin, setOrigin] = useState("");
  const [videoFile, setVideoFile] = useState(null);
  const [subsFile, setSubsFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [uploaded, setUploaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [mounted, setMounted] = useState(false);
  const backend = useServerDiagnostics(serverBase);
  const network = useNetworkCandidates(serverBase);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const serverOverride = Array.isArray(router.query.server) ? router.query.server[0] : router.query.server;
    setMounted(true);
    setOrigin(window.location.origin);
    setServerBase(normalizeServerBase(serverOverride || getDefaultServerBase()));
    setRoomId((current) => current || nanoid(6).toUpperCase());
  }, [router.query.server]);

  const shareLink = useMemo(() => {
    if (!roomId || !origin) return "";
    return `${origin}${buildRoomPath(roomId, mode)}`;
  }, [mode, origin, roomId]);
  const suggestedLanUrl = mode === "LAN" ? network.candidates[0]?.url : "";
  const maxUploadBytes = backend.diagnostics?.maxUploadBytes;
  const maxUploadLabel = maxUploadBytes ? formatBytes(maxUploadBytes) : "";
  const p2pPrepareSupported = Boolean(backend.capabilities?.p2pPrepare || backend.diagnostics?.supportsP2pPrepare);
  const backendUsable = backend.status !== "offline" && backend.status !== "degraded";
  const canPrepareRoom = Boolean(videoFile)
    && !uploaded
    && !uploading
    && backendUsable
    && (mode !== "INTERNET" || p2pPrepareSupported);

  const connectionChecks = useMemo(() => {
    if (!mounted) return [];

    const pageProtocol = window.location.protocol;
    const pageHost = window.location.hostname;
    const localPage = isLocalHostname(pageHost);
    const httpsPage = pageProtocol === "https:" || localPage;
    const publicBackend = /^https:\/\//i.test(serverBase);

    const baseChecks = [
      {
        label: "Sync server",
        value: backend.status === "ready" ? "Ready" : backend.status,
        ready: backend.status === "ready"
      },
      {
        label: "Camera and mic",
        value: httpsPage ? "Allowed" : "Needs HTTPS",
        ready: httpsPage
      }
    ];

    if (mode !== "INTERNET") {
      return [
        ...baseChecks,
        {
          label: "Wi-Fi invite",
          value: localPage ? "Use this computer's LAN IP" : "Link is network-ready",
          ready: !localPage
        },
        {
          label: "TURN relay",
          value: backend.diagnostics?.turnConfigured ? "Configured" : "Optional",
          ready: true
        }
      ];
    }

    if (!backend.internet?.checks?.length) {
      return [
        ...baseChecks,
        {
          label: "P2P rooms",
          value: p2pPrepareSupported ? "Ready" : backend.status === "ready" ? "Update backend" : "Checking",
          ready: p2pPrepareSupported
        },
        {
          label: "Public backend",
          value: publicBackend ? "HTTPS URL set" : "Needs public HTTPS",
          ready: publicBackend
        },
        {
          label: "TURN relay",
          value: backend.diagnostics?.turnConfigured ? "Configured" : "Recommended",
          ready: Boolean(backend.diagnostics?.turnConfigured)
        }
      ];
    }

    return [
      ...baseChecks,
      {
        label: "P2P rooms",
        value: p2pPrepareSupported ? "Ready" : "Update backend",
        ready: p2pPrepareSupported
      },
      ...backend.internet.checks
        .filter((check) => check.id !== "cors")
        .map((check) => ({
          label: check.label,
          value: check.ready ? "Ready" : "Needs setup",
          ready: check.ready
        }))
    ];
  }, [backend.diagnostics?.turnConfigured, backend.internet?.checks, backend.status, mode, mounted, p2pPrepareSupported, serverBase]);

  async function copyShareLink() {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  async function copyRoomCode() {
    if (!roomId) return;
    await navigator.clipboard.writeText(roomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1200);
  }

  async function shareInvite() {
    if (!shareLink) return;
    if (navigator.share) {
      await navigator.share({
        title: `Binge room ${roomId}`,
        text: `Join my Binge room ${roomId}`,
        url: shareLink
      });
      return;
    }
    await copyShareLink();
  }

  async function handleUpload() {
    if (!roomId || !videoFile || !serverBase) return;
    const uploadServerBase = normalizeServerBase(serverBase);
    setUploading(true);
    setUploadProgress(0);
    setUploadError("");

    try {
      const validationError = validateMediaSelection({
        videoFile,
        subsFile,
        maxUploadBytes: mode === "LAN" ? maxUploadBytes : undefined
      });
      if (validationError) throw new Error(validationError);

      if (backend.status === "offline") {
        throw new Error("Upload server is unreachable.");
      }
      if (backend.status === "degraded") {
        throw new Error(backend.detail || "Upload server is not ready.");
      }

      if (mode === "INTERNET") {
        if (!p2pPrepareSupported) {
          throw new Error("This backend is reachable but does not support free P2P rooms yet. Redeploy the latest backend, then try again.");
        }
        setUploadProgress(20);
        await saveLocalMedia(roomId, videoFile, subsFile);
        setUploadProgress(60);
        await preparePeerRoom({ serverBase: uploadServerBase, roomId, videoFile, subsFile });
        setUploadProgress(100);
      } else {
        await uploadRoom({
          serverBase: uploadServerBase,
          roomId,
          mode,
          videoFile,
          subsFile,
          onProgress: setUploadProgress
        });
      }
      setUploaded(true);
    } catch (error) {
      setUploadError(error.message || "Upload failed. Check that the Node server is running.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="min-h-screen bg-canvas px-5 py-6 text-ink sm:px-8">
      <Head>
        <title>Host - Binge</title>
      </Head>

      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <button className="text-sm font-semibold text-muted transition hover:text-ink" onClick={() => router.push("/")}>
            Binge
          </button>
          <div className="whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1 text-xs text-muted shadow-soft">
            {mode === "LAN" ? "Nearby Wi-Fi" : "Internet"} mode
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-line bg-surface p-6 shadow-soft">
            <div className="mb-8 max-w-2xl space-y-3">
              <p className="text-sm font-medium text-muted">Room {roomId}</p>
              <h1 className="text-4xl font-semibold leading-tight text-ink sm:text-5xl">
                Choose a film, then bring everyone into sync.
              </h1>
              <p className="text-muted">
                {mode === "LAN"
                  ? "LAN mode streams the uploaded file directly from this server to everyone nearby."
                  : "Internet mode keeps the movie on this browser and sends viewers a peer-to-peer WebRTC stream, so the sync server never stores or serves the video."}
              </p>
            </div>

            <UploadPanel
              videoFile={videoFile}
              subsFile={subsFile}
              maxUploadLabel={maxUploadLabel}
              onVideoChange={(event) => {
                setVideoFile(event.target.files?.[0] || null);
                setUploaded(false);
                setUploadProgress(0);
                setUploadError("");
              }}
              onSubsChange={(event) => {
                setSubsFile(event.target.files?.[0] || null);
                setUploaded(false);
                setUploadProgress(0);
                setUploadError("");
              }}
            />

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                className={`h-12 rounded-lg px-6 font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
                  uploaded
                    ? "border border-line bg-wash text-muted"
                    : "bg-neon text-black shadow-glow hover:bg-neon/90"
                }`}
                onClick={handleUpload}
                disabled={!canPrepareRoom}
              >
                {uploaded ? "Room prepared" : uploading ? "Preparing stream..." : "Prepare room"}
              </button>
              <button
                className={`h-12 rounded-lg px-6 font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
                  uploaded
                    ? "bg-neon text-black shadow-glow hover:bg-neon/90"
                    : "border border-line bg-wash text-ink hover:border-neon"
                }`}
                onClick={() => router.push(buildRoomPath(roomId, mode, { host: true }))}
                disabled={!uploaded}
              >
                Enter room
              </button>
            </div>
            {uploading && (
              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted">
                  <span>{mode === "INTERNET" ? "Preparing local source" : "Uploading source"}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-wash">
                  <div
                    className="h-full rounded-full bg-neon transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
            {uploadError && <p className="mt-4 text-sm text-red-300">{uploadError}</p>}
          </div>

          <aside className="rounded-lg border border-line bg-surface p-5 shadow-soft">
            <div className="space-y-5">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">Backend</p>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between rounded-lg bg-wash px-3 py-2 text-sm">
                    <span className="text-muted">{mode === "INTERNET" ? "P2P rooms" : "Server"}</span>
                    <span className="font-semibold text-ink">{mode === "INTERNET" ? p2pPrepareSupported ? "ready" : backend.status === "ready" ? "update backend" : "checking" : backend.status}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-wash px-3 py-2 text-sm">
                    <span className="text-muted">Server</span>
                    <span className="font-semibold text-ink">{backend.status}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-wash px-3 py-2 text-sm">
                    <span className="text-muted">{mode === "INTERNET" ? "Video storage" : "Uploads"}</span>
                    <span className="font-semibold text-ink">{mode === "INTERNET" ? "browser only" : backend.ready?.uploadDirWritable ? "ready" : "checking"}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-wash px-3 py-2 text-sm">
                    <span className="text-muted">TURN</span>
                    <span className="font-semibold text-ink">{backend.diagnostics?.turnConfigured ? "configured" : "not set"}</span>
                  </div>
                  {mode === "INTERNET" && backend.status === "ready" && !backend.diagnostics?.turnConfigured && (
                    <p className="text-xs leading-5 text-muted">
                      Internet rooms are free by default because video never touches the backend. TURN is still useful for restrictive networks.
                    </p>
                  )}
                  {mode === "INTERNET" && backend.status === "ready" && !p2pPrepareSupported && (
                    <p className="text-xs leading-5 text-amber-200">
                      This backend is an older build. Redeploy the server so `/upload/p2p` and `/capabilities` are available.
                    </p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">Share</p>
                <p className="mt-2 break-all text-sm leading-6 text-ink">{shareLink || "Generating link..."}</p>
              </div>
              <button
                className="h-11 w-full rounded-lg border border-line bg-wash font-semibold text-ink transition hover:border-neon"
                onClick={copyShareLink}
              >
                {copied ? "Copied" : "Copy invite link"}
              </button>
              <div className="grid grid-cols-2 gap-3">
                <button
                  className="h-11 rounded-lg border border-line bg-wash font-semibold text-ink transition hover:border-neon"
                  onClick={copyRoomCode}
                >
                  {copiedCode ? "Copied" : "Copy code"}
                </button>
                <button
                  className="h-11 rounded-lg bg-neon font-semibold text-black transition hover:bg-neon/90"
                  onClick={shareInvite}
                >
                  Share
                </button>
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted" htmlFor="server-base">
                  Backend URL
                </label>
                <input
                  id="server-base"
                  value={serverBase}
                  onChange={(event) => setServerBase(event.target.value.trim())}
                  className="mt-2 h-11 w-full rounded-lg border border-line bg-wash px-3 text-sm text-ink outline-none transition placeholder:text-muted focus:border-neon"
                  placeholder="https://your-sync-server.example.com"
                />
                {suggestedLanUrl && suggestedLanUrl !== serverBase && (
                  <button
                    className="mt-2 h-10 w-full rounded-lg border border-line bg-wash text-sm font-semibold text-ink transition hover:border-neon"
                    onClick={() => setServerBase(suggestedLanUrl)}
                  >
                    Use Wi-Fi address
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {connectionChecks.map((check) => (
                  <div key={check.label} className="flex items-center justify-between gap-3 rounded-lg bg-wash px-3 py-2 text-sm">
                    <span className="text-muted">{check.label}</span>
                    <span className={`font-semibold ${check.ready ? "text-neon" : "text-amber-300"}`}>{check.value}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg bg-wash p-4 text-sm leading-6 text-muted">
                {mode === "INTERNET" && backend.status === "ready" && !p2pPrepareSupported
                  ? "The sync server is reachable, but it is missing the latest P2P room API. Redeploy the backend before preparing an internet room."
                  : mode === "INTERNET" && backend.internet?.status !== "ready"
                  ? "Internet rooms need a public HTTPS sync backend. The selected movie stays in this browser for the full screening."
                  : "Keep this browser open as the host. For phones on Wi-Fi, use this computer's LAN address instead of localhost. Internet rooms use this device's upload bandwidth instead of backend video storage."}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
