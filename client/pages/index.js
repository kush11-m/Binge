import Head from "next/head";
import { useRouter } from "next/router";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");

  return (
    <div className="min-h-screen bg-atmos flex items-center justify-center px-6">
      <Head>
        <title>Binge</title>
      </Head>
      <div className="max-w-lg w-full text-center space-y-8 animate-rise">
        <div className="space-y-2">
          <p className="text-sm uppercase tracking-[0.5em] text-white/40">LAN Sync Video</p>
          <h1 className="text-5xl font-semibold neon-text">Binge</h1>
          <p className="text-white/60">Host once. Watch together. Zero drift.</p>
        </div>

        <div className="panel rounded-xl p-6 space-y-4">
          <button
            className="w-full py-3 rounded-xl bg-neon text-black font-semibold shadow-glow hover:shadow-[0_0_24px_rgba(0,255,136,0.8)] transition"
            onClick={() => router.push("/host")}
          >
            Start Session
          </button>
          <div className="space-y-3">
            <input
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              placeholder="Enter room ID"
              className="w-full rounded-xl bg-black border border-white/20 px-4 py-3 text-white focus:border-neon focus:outline-none"
            />
            <button
              className="w-full py-3 rounded-xl border border-neon text-neon hover:bg-neon/10 transition"
              onClick={() => roomId && router.push(`/room/${roomId.trim()}`)}
            >
              Join Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
