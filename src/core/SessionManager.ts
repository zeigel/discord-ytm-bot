import type { AppLogger } from '../logger.js';
import type { MediaProvider, TrackMeta } from '../media/MediaProvider.js';
import { GuildSession } from './GuildSession.js';
import type { EnqueueResult } from './GuildSession.js';
import { createTrack } from './queue.js';
import type { DestroyReason, Requester, Track } from './types.js';
import type { VoiceDriverFactory } from './voice.js';

export interface SessionManagerOptions {
  media: MediaProvider;
  logger: AppLogger;
  maxQueueSize: number;
  streamStartTimeoutMs: number;
  createDriver: VoiceDriverFactory;
  /** Posts a public message to a text channel. Must never throw. */
  announce: (textChannelId: string, message: string) => void;
}

export interface EnqueueRequest {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  meta: TrackMeta;
  requestedBy: Requester;
}

export type EnqueueOutcome =
  | { ok: true; track: Track; startsNow: boolean; position: number; size: number; max: number }
  | { ok: false; reason: 'full'; max: number }
  | { ok: false; reason: 'wrong_channel'; channelId: string }
  | { ok: false; reason: 'join_failed'; error: unknown }
  | { ok: false; reason: 'session_gone' };

/** Owns every GuildSession. Sessions are fully isolated: nothing is shared between guilds. */
export class SessionManager {
  private readonly sessions = new Map<string, GuildSession>();
  private readonly opts: SessionManagerOptions;
  private readonly log: AppLogger;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    this.log = opts.logger;
  }

  get(guildId: string): GuildSession | undefined {
    return this.sessions.get(guildId);
  }

  get count(): number {
    return this.sessions.size;
  }

  /**
   * Adds a track to the guild's queue, creating the session (and joining the voice channel) if
   * there is none. Resolves once the voice connection is ready, so a failed join is reported to
   * the caller. Capacity is checked under the session lock, so two users racing for the last
   * slot cannot both succeed.
   */
  async enqueue(req: EnqueueRequest): Promise<EnqueueOutcome> {
    const track = createTrack(req.meta, req.requestedBy);

    // One retry covers a session that ended between lookup and locking (for example, the last
    // track finished at that instant).
    for (let attempt = 0; attempt < 2; attempt++) {
      let session = this.sessions.get(req.guildId);
      if (session && session.voiceChannelId !== req.voiceChannelId) {
        return { ok: false, reason: 'wrong_channel', channelId: session.voiceChannelId };
      }
      if (!session) {
        try {
          // Synchronous get-or-create: two simultaneous first /play calls cannot both get here.
          session = this.createSession(req);
        } catch (error) {
          this.log.warn({ err: error, guildId: req.guildId }, 'could not create session');
          return { ok: false, reason: 'join_failed', error };
        }
      }

      // No await between the lookup above and this call, so callers reach the lock in call order.
      const result: EnqueueResult = await session.enqueue(track, req.textChannelId);
      if (!result.ok) {
        if (result.reason === 'session_gone') continue;
        return result;
      }

      try {
        await session.ready;
      } catch (error) {
        return { ok: false, reason: 'join_failed', error };
      }
      return { ...result, max: session.maxQueueSize };
    }
    return { ok: false, reason: 'session_gone' };
  }

  /** Destroys every session (shutdown). */
  destroyAll(reason: DestroyReason): void {
    for (const session of [...this.sessions.values()]) session.destroy(reason);
  }

  private createSession(req: EnqueueRequest): GuildSession {
    const session = new GuildSession(
      {
        guildId: req.guildId,
        voiceChannelId: req.voiceChannelId,
        textChannelId: req.textChannelId,
        createDriver: this.opts.createDriver,
      },
      {
        media: this.opts.media,
        logger: this.opts.logger,
        maxQueueSize: this.opts.maxQueueSize,
        streamStartTimeoutMs: this.opts.streamStartTimeoutMs,
        announce: this.opts.announce,
        onDestroyed: (s) => this.handleDestroyed(s),
      },
    );
    this.sessions.set(req.guildId, session);
    return session;
  }

  private handleDestroyed(session: GuildSession): void {
    if (this.sessions.get(session.guildId) === session) this.sessions.delete(session.guildId);
  }
}
