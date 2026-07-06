import { RoomState } from '../types';

export class SyncEngine {
  private DRIFT_THRESHOLD = 0.45;
  private DRIFT_SOFT_THRESHOLD = 0.15;
  private RATE_ADJUST = 0.04;
  private HARD_JUMP_SECONDS = 1.0;

  private offset: number = 0;
  private rateResetTimer: NodeJS.Timeout | null = null;
  private skipSyncUntil: number = 0;
  private state: RoomState = { currentTime: 0, isPlaying: false, serverTime: Date.now() };

  public updateServerState(newState: RoomState) {
    const now = Date.now();
    if (now < this.skipSyncUntil) {
      return false; // Skip redundant updates if we just triggered a local action
    }

    if (newState.serverTime) {
      this.updateOffset(newState.serverTime);
    }
    
    this.state = {
      ...this.state,
      ...newState,
      serverTime: newState.serverTime || Date.now()
    };
    return true; // Indicates state changed and we should potentially sync
  }

  public getState(): RoomState {
    return this.state;
  }

  public setSkipSync(durationMs: number) {
    this.skipSyncUntil = Date.now() + durationMs;
  }

  public getExpectedTime(): number {
    if (!this.state.isPlaying) return this.state.currentTime || 0;
    const serverTime = this.state.serverTime || Date.now();
    const elapsed = (Date.now() + this.offset - serverTime) / 1000;
    return this.state.currentTime + elapsed;
  }

  public syncVideo(videoElement: HTMLVideoElement, forceJump: boolean = false) {
    if (!videoElement || videoElement.readyState < 2) return;

    const expected = this.getExpectedTime();
    const diff = expected - videoElement.currentTime;
    const absDiff = Math.abs(diff);

    // Hard jump
    if (absDiff > this.HARD_JUMP_SECONDS) {
      videoElement.currentTime = expected;
      videoElement.playbackRate = 1;
      if (this.state.isPlaying && videoElement.paused) videoElement.play().catch(() => {});
      if (!this.state.isPlaying && !videoElement.paused) videoElement.pause();
      return;
    }

    // Skip small diffs if paused
    if (!this.state.isPlaying && absDiff < 0.25) {
      if (!videoElement.paused) videoElement.pause();
      return;
    }

    // Moderate drift
    if (forceJump || absDiff > this.DRIFT_THRESHOLD) {
      videoElement.currentTime = expected;
      videoElement.playbackRate = 1;
      if (this.state.isPlaying && videoElement.paused) videoElement.play().catch(() => {});
      if (!this.state.isPlaying && !videoElement.paused) videoElement.pause();
      return;
    }

    // Soft drift correction (adjust playback rate)
    if (this.state.isPlaying && absDiff > this.DRIFT_SOFT_THRESHOLD) {
      const rate = 1 + (diff > 0 ? this.RATE_ADJUST : -this.RATE_ADJUST);
      videoElement.playbackRate = rate;
      if (this.rateResetTimer) clearTimeout(this.rateResetTimer);
      this.rateResetTimer = setTimeout(() => {
        videoElement.playbackRate = 1;
      }, 600);
    }
  }

  private updateOffset(serverTime: number) {
    const sample = serverTime - Date.now();
    this.offset = this.offset ? this.offset * 0.8 + sample * 0.2 : sample;
  }
}
