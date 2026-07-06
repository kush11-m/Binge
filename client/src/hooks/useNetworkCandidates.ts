import { useEffect, useState } from "react";

export type NetworkCandidate = {
  interface: string;
  address: string;
  url: string;
};

export function useNetworkCandidates(serverBase: string) {
  const [candidates, setCandidates] = useState<NetworkCandidate[]>([]);
  const [status, setStatus] = useState<"idle" | "checking" | "ready" | "unavailable">("idle");

  useEffect(() => {
    if (!serverBase) return;
    let cancelled = false;

    async function load() {
      setStatus("checking");
      try {
        const response = await fetch(`${serverBase}/network`, { cache: "no-store" });
        if (!response.ok) throw new Error("Network discovery unavailable");
        const payload = await response.json();
        if (cancelled) return;
        const nextCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        setCandidates(nextCandidates);
        setStatus(nextCandidates.length ? "ready" : "unavailable");
      } catch (_error) {
        if (cancelled) return;
        setCandidates([]);
        setStatus("unavailable");
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [serverBase]);

  return { candidates, status };
}
