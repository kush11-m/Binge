import { useEffect, useState } from "react";

export type ServerDiagnostics = {
  status: "checking" | "ready" | "degraded" | "offline";
  detail: string;
  health?: {
    status: string;
    rooms: number;
    turnConfigured: boolean;
  };
  ready?: {
    status: string;
    uploadDirWritable: boolean;
  };
  diagnostics?: {
    activeRooms: number;
    activeCallRooms: number;
    maxRoomUsers: number;
    maxUploadBytes: number;
    supportedVideoExtensions: string[];
    supportedSubtitleExtensions: string[];
    turnConfigured: boolean;
    corsOrigin: "all" | "restricted";
  };
  internet?: {
    status: "ready" | "needs-attention";
    publicUrl: string;
    checks: Array<{
      id: string;
      label: string;
      ready: boolean;
      detail: string;
    }>;
  };
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

export function useServerDiagnostics(serverBase: string, pollMs = 15000) {
  const [diagnostics, setDiagnostics] = useState<ServerDiagnostics>({
    status: "checking",
    detail: "Checking backend"
  });

  useEffect(() => {
    if (!serverBase) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check() {
      try {
        const [health, ready, runtime, internet] = await Promise.all([
          getJson<ServerDiagnostics["health"]>(`${serverBase}/health`),
          getJson<ServerDiagnostics["ready"]>(`${serverBase}/ready`),
          getJson<ServerDiagnostics["diagnostics"]>(`${serverBase}/diagnostics`),
          getJson<ServerDiagnostics["internet"]>(`${serverBase}/internet-readiness`)
        ]);

        if (cancelled) return;

        const uploadReady = Boolean(ready?.uploadDirWritable);
        setDiagnostics({
          status: uploadReady ? "ready" : "degraded",
          detail: uploadReady ? "Backend ready" : "Upload storage is not writable",
          health,
          ready,
          diagnostics: runtime,
          internet
        });
      } catch (error) {
        if (cancelled) return;
        setDiagnostics({
          status: "offline",
          detail: error instanceof Error ? error.message : "Backend unreachable"
        });
      } finally {
        if (!cancelled && pollMs > 0) {
          timer = setTimeout(check, pollMs);
        }
      }
    }

    setDiagnostics({ status: "checking", detail: "Checking backend" });
    void check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverBase, pollMs]);

  return diagnostics;
}
