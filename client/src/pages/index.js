import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { buildRoomPath, getDefaultServerBase, isLocalHostname, normalizeServerBase } from "../services/connection";
import { useServerDiagnostics } from "../hooks/useServerDiagnostics";
import { useNetworkCandidates } from "../hooks/useNetworkCandidates";

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");
  const [mode, setMode] = useState("LAN");
  const [serverBase, setServerBase] = useState("");
  const [mounted, setMounted] = useState(false);
  const backend = useServerDiagnostics(serverBase, 20000);
  const network = useNetworkCandidates(serverBase);

  useEffect(() => {
    setMounted(true);
    setServerBase(getDefaultServerBase());
  }, []);

  const joinDisabled = !roomId.trim() || !serverBase.trim();
  const suggestedLanUrl = mode === "LAN" ? network.candidates[0]?.url : "";
  const connectionHint = useMemo(() => {
    if (mode === "INTERNET") {
      return serverBase.startsWith("https://") ? "Public sync server" : "Set a public HTTPS backend";
    }
    if (mounted && isLocalHostname(window.location.hostname)) {
      return "Use LAN IP for phones";
    }
    return "Same network";
  }, [mode, mounted, serverBase]);

  function openHost() {
    const params = new URLSearchParams({ mode });
    if (serverBase.trim()) params.set("server", normalizeServerBase(serverBase.trim()));
    router.push(`/host?${params.toString()}`);
  }

  function joinRoom() {
    if (joinDisabled) return;
    router.push(buildRoomPath(roomId.trim(), mode, { serverBase: normalizeServerBase(serverBase.trim()) }));
  }

  const modes = [
    {
      id: "LAN",
      title: "Nearby Wi-Fi",
      detail: "Lowest overhead on the same network. Best for home watch rooms."
    },
    {
      id: "INTERNET",
      title: "Internet",
      detail: "Share with people anywhere through a public sync server and WebRTC relay."
    }
  ];

  return (
    <main className="min-h-screen bg-canvas px-5 py-6 text-ink sm:px-8">
      <Head>
        <title>Binge</title>
      </Head>

      <section className="mx-auto flex min-h-[calc(100vh-48px)] w-full max-w-6xl flex-col">
        <nav className="flex items-center justify-between">
          <div className="text-[15px] font-semibold tracking-wide">Binge</div>
          <div className="whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1 text-xs text-muted shadow-soft">
            Ultra-low latency sync
          </div>
        </nav>

        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="max-w-2xl space-y-5">
            <div className="space-y-4">
              <p className="text-sm font-medium text-muted">Watch together, near or far.</p>
              <h1 className="text-balance text-4xl font-semibold leading-[1.04] tracking-normal text-ink sm:text-6xl lg:text-[64px]">
                One room for the movie and the conversation.
              </h1>
              <p className="max-w-xl text-base leading-7 text-muted sm:text-lg">
                Host a source-quality stream on Wi-Fi or relay it over the internet, with synced playback and built-in camera and mic.
              </p>
            </div>
            <div className="grid max-w-xl gap-3 sm:grid-cols-2">
              {modes.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setMode(item.id)}
                  className={`rounded-lg border p-4 text-left transition ${
                    mode === item.id
                      ? "border-neon bg-neon text-black shadow-glow"
                      : "border-line bg-surface text-ink hover:border-neon/40"
                  }`}
                >
                  <span className="text-sm font-semibold">{item.title}</span>
                  <span className={`mt-2 block text-sm leading-6 ${mode === item.id ? "text-black/70" : "text-muted"}`}>
                    {item.detail}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface p-5 shadow-soft">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">Session</p>
                <h2 className="mt-1 text-2xl font-semibold text-ink">{mode === "LAN" ? "Nearby Wi-Fi" : "Internet"} stream</h2>
              </div>
              <div className="h-3 w-3 rounded-full bg-ready shadow-[0_0_0_6px_rgba(52,199,89,0.12)]" />
            </div>

            <button
              className="h-12 w-full rounded-lg bg-neon font-semibold text-black shadow-glow transition hover:bg-neon/90"
              onClick={openHost}
            >
              Host a room
            </button>

            <div className="my-5 flex items-center gap-3 text-xs text-muted">
              <div className="h-px flex-1 bg-line" />
              or join
              <div className="h-px flex-1 bg-line" />
            </div>

            <div className="space-y-3">
              <input
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
                placeholder="Room code"
                className="h-12 w-full rounded-lg border border-line bg-wash px-4 text-ink outline-none transition placeholder:text-muted focus:border-neon"
              />
              <input
                value={serverBase}
                onChange={(event) => setServerBase(normalizeServerBase(event.target.value.trim()))}
                placeholder={mode === "LAN" ? "http://192.168.1.20:3002" : "https://your-sync-server.example.com"}
                className="h-12 w-full rounded-lg border border-line bg-wash px-4 text-ink outline-none transition placeholder:text-muted focus:border-neon"
              />
              <div className="flex items-center justify-between gap-3 rounded-lg bg-wash px-3 py-2 text-xs">
                <span className="text-muted">{connectionHint}</span>
                <span className={`font-semibold ${backend.status === "ready" ? "text-neon" : "text-amber-300"}`}>
                  {backend.status}
                </span>
              </div>
              {suggestedLanUrl && suggestedLanUrl !== serverBase && (
                <button
                  className="h-11 w-full rounded-lg border border-line bg-surface text-sm font-semibold text-ink transition hover:border-neon"
                  onClick={() => setServerBase(suggestedLanUrl)}
                >
                  Use Wi-Fi address
                </button>
              )}
              <button
                className="h-12 w-full rounded-lg border border-line bg-surface font-semibold text-ink transition hover:border-neon disabled:cursor-not-allowed disabled:opacity-45"
                onClick={joinRoom}
                disabled={joinDisabled}
              >
                Join room
              </button>
            </div>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 pb-2 text-sm text-muted">
          <span>Adaptive quality. Browser-native playback. No account required.</span>
          <span>{mode === "LAN" ? "Best on the same router" : "Requires a reachable server URL"}</span>
        </footer>
      </section>
    </main>
  );
}
