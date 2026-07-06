import type { ProviderStatus } from "../types";

export abstract class StreamingProvider extends EventTarget {
  protected status: ProviderStatus = { label: "Idle" };

  public getStatus() {
    return this.status;
  }

  protected setStatus(next: ProviderStatus) {
    this.status = next;
    this.dispatchEvent(new CustomEvent("status", { detail: next }));
  }

  abstract attach(video: HTMLVideoElement): Promise<void> | void;

  abstract destroy(): void;
}
