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
	    supportsP2pPrepare?: boolean;
	    turnConfigured: boolean;
	    corsOrigin: "all" | "restricted";
	  };
	  capabilities?: {
	    status: string;
	    apiVersion?: number;
	    p2pPrepare?: boolean;
	    lanUpload?: boolean;
	    diagnostics?: boolean;
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

async function getOptionalJson<T>(url: string): Promise<T | undefined> {
  try {
    return await getJson<T>(url);
  } catch (_error) {
    return undefined;
  }
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
        const health = await getJson<ServerDiagnostics["health"]>(`${serverBase}/health`);
        const [ready, runtime, internet, capabilities] = await Promise.all([
          getOptionalJson<ServerDiagnostics["ready"]>(`${serverBase}/ready`),
          getOptionalJson<ServerDiagnostics["diagnostics"]>(`${serverBase}/diagnostics`),
          getOptionalJson<ServerDiagnostics["internet"]>(`${serverBase}/internet-readiness`),
          getOptionalJson<ServerDiagnostics["capabilities"]>(`${serverBase}/capabilities`)
        ]);

        if (cancelled) return;

        const uploadReady = ready ? Boolean(ready.uploadDirWritable) : true;
        const limitedDiagnostics = !ready || !runtime;
        setDiagnostics({
          status: uploadReady ? "ready" : "degraded",
          detail: uploadReady
            ? limitedDiagnostics
              ? "Backend reachable; deploy latest backend for full diagnostics"
              : "Backend ready"
            : "Upload storage is not writable",
          health,
          ready,
          diagnostics: runtime,
          capabilities,
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
