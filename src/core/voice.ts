/**
 * The seam between session logic and the Discord voice layer. GuildSession only sees these
 * interfaces, so it can be tested with a fake driver and never imports discord.js or @discordjs/voice.
 * The real implementation is src/discord/voiceDriver.ts.
 */
import type { Readable } from 'node:stream';

export interface VoiceTarget {
  guildId: string;
  channelId: string;
}

/** How one track's playback ended. */
export type TrackEnd = { reason: 'finished' | 'stopped' } | { reason: 'error'; error: unknown };

export interface PlayHandle {
  /** Resolves once audio is actually playing. Rejects if it cannot start (error or timeout). */
  started: Promise<void>;
  /**
   * Resolves exactly once when this track's playback is over: finished, stopped, or failed,
   * including a failure to start. It never rejects.
   */
  ended: Promise<TrackEnd>;
}

export interface VoiceDriver {
  /** Resolves when the voice connection is ready. Rejects with VoiceJoinError. */
  connect(): Promise<void>;
  /** Plays one stream. Only one stream plays at a time. */
  play(stream: Readable, startTimeoutMs: number): PlayHandle;
  /** Stops the current track, if any. Its `ended` resolves with reason "stopped". */
  stop(): void;
  /** Stops audio and leaves the channel. Idempotent. */
  destroy(): void;
}

export interface VoiceDriverHandlers {
  /** The connection was lost and did not recover (kicked, channel deleted, network). */
  onDisconnected(): void;
}

/** Creates a driver and starts joining. May throw VoiceJoinError (for example, unknown guild). */
export type VoiceDriverFactory = (
  target: VoiceTarget,
  handlers: VoiceDriverHandlers,
) => VoiceDriver;
