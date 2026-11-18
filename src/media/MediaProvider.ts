import type { Readable } from 'node:stream';

export interface TrackMeta {
  videoId: string;
  /** Canonical watch URL. */
  url: string;
  title: string;
  durationSec: number;
  thumbnailUrl: string | undefined;
  isLive: boolean;
}

/** Seam between session logic and the audio source (local yt-dlp now, remote sidecar later). */
export interface MediaProvider {
  /** Looks up metadata for one video. Rejects with MediaError. */
  resolve(videoId: string, signal?: AbortSignal): Promise<TrackMeta>;
  /**
   * Starts streaming the audio of one video. The returned stream errors with a MediaError if
   * extraction fails, and aborting the signal stops the extraction process.
   */
  openStream(videoId: string, signal: AbortSignal): Promise<Readable>;
}
