import Head from "next/head";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { nanoid } from "nanoid";
import UploadPanel from "../components/UploadPanel";

export default function Host() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");
  const [serverBase, setServerBase] = useState("");
  const [hostname, setHostname] = useState("");
  const [videoFile, setVideoFile] = useState(null);
  const [subsFile, setSubsFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploaded, setUploaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname;
    setHostname(host);
    const fallbackPort = process.env.NEXT_PUBLIC_SERVER_PORT || "3002";
    setServerBase(process.env.NEXT_PUBLIC_SERVER_URL || `http://${host}:${fallbackPort}`);
  }, []);

  function handleStartSession() {
    setRoomId(nanoid(6));
    setUploaded(false);
  }

  async function handleCopyCode() {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      setCopied(false);
    }
  }

  async function handleUpload() {
    if (!roomId || !videoFile || !serverBase) return;
    setUploading(true);
    setUploadError("");

    const formData = new FormData();
    formData.append("roomId", roomId);
    formData.append("video", videoFile);
    if (subsFile) {
      formData.append("subs", subsFile);
    }

    try {
      const response = await fetch(`${serverBase}/upload`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Upload failed");
      }

      setUploaded(true);
    } catch (error) {
      setUploadError(error.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const shareLink = roomId && hostname ? `http://${hostname}:3000/room/${roomId}` : "";

  return (
    <div className="min-h-screen bg-atmos px-6 py-10">
      <Head>
        <title>Host Session - SyncStream</title>
      </Head>

      <div className="max-w-4xl mx-auto space-y-8">
        <header className="flex flex-col gap-3">
          <p className="text-sm uppercase tracking-[0.4em] text-white/40">Host Dashboard</p>
          <h1 className="text-4xl font-semibold neon-text">Create the Sync</h1>
          <p className="text-white/60">Upload your video, share the link, and start streaming.</p>
        </header>

        <div className="grid md:grid-cols-[1.2fr_0.8fr] gap-6">
          <div className="space-y-6">
            <div className="panel rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-white/70">Room Code</span>
                <span className="font-mono text-neon">{roomId || "Not started"}</span>
              </div>
              <button
                className="w-full py-3 rounded-xl bg-neon text-black font-semibold shadow-glow hover:shadow-[0_0_24px_rgba(0,255,136,0.8)] transition"
                onClick={handleStartSession}
              >
                Start Session
              </button>
            </div>

            <UploadPanel
              videoFile={videoFile}
              subsFile={subsFile}
              onVideoChange={(event) => setVideoFile(event.target.files[0])}
              onSubsChange={(event) => setSubsFile(event.target.files[0])}
            />

            <div className="panel rounded-xl p-6 space-y-4">
              <button
                className="w-full py-3 rounded-xl border border-neon text-neon hover:bg-neon/10 transition disabled:opacity-50"
                onClick={handleUpload}
                disabled={!roomId || !videoFile || uploading}
              >
                {uploading ? "Uploading..." : "Start Streaming"}
              </button>
              {uploadError && <p className="text-red-400 text-sm">{uploadError}</p>}
              {uploaded && (
                <button
                  className="w-full py-3 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
                  onClick={() => router.push(`/room/${roomId}`)}
                >
                  Enter Room
                </button>
              )}
            </div>
          </div>

          <aside className="panel rounded-xl p-6 space-y-4">
            <p className="text-sm uppercase tracking-[0.3em] text-white/40">Share</p>
            <div className="space-y-2">
              <p className="text-white/80 break-all">{shareLink || "Start a session to generate a link."}</p>
              <button
                className="w-full py-2 rounded-xl border border-neon text-neon hover:bg-neon/10 transition disabled:opacity-50"
                onClick={handleCopyCode}
                disabled={!roomId}
              >
                {copied ? "Copied!" : "Copy Room Code"}
              </button>
            </div>
            <p className="text-xs text-white/50">
              Joiners open SyncStream on the host link and enter the room code.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
