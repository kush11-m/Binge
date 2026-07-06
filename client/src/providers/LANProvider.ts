import { StreamingProvider } from "./StreamingProvider";

export class LANProvider extends StreamingProvider {
  private sourceUrl: string;

  constructor(serverBase: string, videoUrl: string, hlsUrl?: string | null) {
    super();
    this.sourceUrl = hlsUrl ? `${serverBase}${hlsUrl}` : `${serverBase}${videoUrl}`;
    this.setStatus({
      label: "LAN direct",
      detail: "Serving the original file over the local network",
      quality: "Source quality",
      transport: "LAN"
    });
  }

  attach(video: HTMLVideoElement) {
    if (video.src !== this.sourceUrl) {
      video.src = this.sourceUrl;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
    }
  }

  destroy() {}
}
