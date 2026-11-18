import type { AppLogger } from '../logger.js';
import { MediaError, userMessage } from '../media/errors.js';
import type { MediaProvider } from '../media/MediaProvider.js';
import { Mutex } from '../utils/mutex.js';
import { formatDuration } from '../utils/time.js';
import { VoiceJoinError } from './errors.js';
import { addTrack, advanceQueue, clearQueue, isFull, sizeOf } from './queue.js';
import type { QueueState } from './queue.js';
import type { DestroyReason, PlaylistFeed, SessionState, Track } from './types.js';
import type { TrackEnd, VoiceDriver, VoiceDriverFactory } from './voice.js';

export interface SessionDeps {
  media: MediaProvider;
  logger: AppLogger;
  maxQueueSize: number;
  streamStartTimeoutMs: number;
  /** Posts a public message to a text channel. Must never throw. */
  announce: (textChannelId: string, message: string) => void;
  /** Called once, when the session is destroyed. The SessionManager uses it to drop the session. */
  onDestroyed: (session: GuildSession, reason: DestroyReason) => void;
}

export interface SessionInit {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  createDriver: VoiceDriverFactory;
}

export type EnqueueResult =
  | { ok: true; track: Track; startsNow: boolean; position: number; size: number }
  | { ok: false; reason: 'full'; max: number }
  | { ok: false; reason: 'session_gone' };

export type SkipResult =
  { ok: true; skipped: Track; next: Track | null } | { ok: false; reason: 'nothing_playing' };

/** The one track the session is currently trying to play. Compared by identity. */
interface ActiveTrack {
  track: Track;
  abort: AbortController;
  skipped: boolean;
}

/**
 * One voice session per guild: the queue, the voice connection and the state machine (section 7.4).
 *
 * Rules that keep it correct:
 * - Every mutation runs through the per-guild lock, and each locked section is synchronous.
 * - A track's `ended` promise is the single trigger for advancing. Skip only stops the track;
 *   it flows through the same path as a natural end.
 * - destroy() is synchronous and idempotent. Locked sections check for "destroyed" first.
 */
export class GuildSession {
  readonly guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  /** Playlist feeds (section 7.8). Always empty until Phase 3b. */
  readonly feeds: PlaylistFeed[] = [];
  /** Resolves when connected. Rejects if the join failed or the session died while connecting. */
  readonly ready: Promise<void>;

  private currentState: SessionState = 'connecting';
  private readonly q: QueueState = { current: null, queue: [] };
  private readonly lock = new Mutex();
  private readonly driver: VoiceDriver;
  private readonly deps: SessionDeps;
  private readonly log: AppLogger;
  private active: ActiveTrack | null = null;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (err: unknown) => void = () => undefined;

  constructor(init: SessionInit, deps: SessionDeps) {
    this.guildId = init.guildId;
    this.voiceChannelId = init.voiceChannelId;
    this.textChannelId = init.textChannelId;
    this.deps = deps;
    this.log = deps.logger.child({ guildId: init.guildId });

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined); // callers handle it; never leave it unhandled

    this.driver = init.createDriver(
      { guildId: init.guildId, channelId: init.voiceChannelId },
      { onDisconnected: () => this.handleDisconnected() },
    );
    void this.driver.connect().then(
      () => this.onConnected(),
      (err: unknown) => this.onConnectFailed(err),
    );
  }

  get state(): SessionState {
    return this.currentState;
  }

  /** The playing track, or the one about to play. */
  get current(): Track | null {
    return this.q.current;
  }

  /** Waiting tracks in play order. Treat as read-only. */
  get queue(): readonly Track[] {
    return this.q.queue;
  }

  /** Playing plus waiting. */
  get size(): number {
    return sizeOf(this.q);
  }

  get maxQueueSize(): number {
    return this.deps.maxQueueSize;
  }

  get isFull(): boolean {
    return isFull(this.q, this.deps.maxQueueSize);
  }

  /**
   * Adds a track. Calls are served in the order they are made, so concurrent callers are FIFO.
   * The first track in an empty session starts playing as soon as the connection is ready.
   */
  enqueue(track: Track, textChannelId: string): Promise<EnqueueResult> {
    return this.lock.runExclusive(() => this.enqueueLocked(track, textChannelId));
  }

  /** Stops the current track; the normal "track ended" path then plays the next one. */
  skip(): Promise<SkipResult> {
    return this.lock.runExclusive((): SkipResult => {
      const active = this.active;
      if (this.currentState === 'destroyed' || !active || active.skipped) {
        return { ok: false, reason: 'nothing_playing' };
      }
      active.skipped = true;
      active.abort.abort();
      this.driver.stop();
      return { ok: true, skipped: active.track, next: this.q.queue[0] ?? null };
    });
  }

  /**
   * Stops audio, kills child processes, leaves the channel, empties the queue and feeds, and tells
   * the manager. Safe to call at any time and more than once.
   */
  destroy(reason: DestroyReason): void {
    if (this.currentState === 'destroyed') return;
    const wasConnecting = this.currentState === 'connecting';
    this.setState('destroyed');

    const active = this.active;
    this.active = null;
    active?.abort.abort();
    clearQueue(this.q);
    this.feeds.length = 0;

    if (wasConnecting) this.rejectReady(new VoiceJoinError('Lost the voice connection'));
    try {
      this.driver.destroy();
    } catch (err) {
      this.log.warn({ err }, 'voice driver destroy failed');
    }
    this.log.info({ reason }, 'session destroyed');
    this.deps.onDestroyed(this, reason);
  }

  private enqueueLocked(track: Track, textChannelId: string): EnqueueResult {
    if (this.currentState === 'destroyed') return { ok: false, reason: 'session_gone' };

    const added = addTrack(this.q, track, this.deps.maxQueueSize);
    if (!added.ok) return added;

    this.textChannelId = textChannelId;
    this.log.info(
      { trackId: track.id, videoId: track.videoId, position: added.position, size: added.size },
      'track enqueued',
    );
    // While still connecting, the track waits as `current` and starts in onConnected().
    if (added.startsNow && this.currentState === 'idle') this.beginCurrent();
    return {
      ok: true,
      track,
      startsNow: added.startsNow,
      position: added.position,
      size: added.size,
    };
  }

  private onConnected(): Promise<void> {
    return this.lock.runExclusive(() => {
      if (this.currentState !== 'connecting') return; // destroyed while joining
      this.setState('idle');
      this.resolveReady();
      if (this.q.current) this.beginCurrent();
    });
  }

  private onConnectFailed(err: unknown): void {
    this.log.warn({ err }, 'voice join failed');
    this.rejectReady(err);
    this.destroy('join_failed');
  }

  private handleDisconnected(): void {
    this.log.info('voice connection lost');
    this.destroy('disconnected');
  }

  /** Starts playing `q.current`. Call under the lock, with the connection ready. */
  private beginCurrent(): void {
    const track = this.q.current;
    if (!track) return;
    const active: ActiveTrack = { track, abort: new AbortController(), skipped: false };
    this.active = active;
    this.setState('buffering');
    this.log.info(
      { trackId: track.id, videoId: track.videoId, title: track.title },
      'track starting',
    );
    void this.runTrack(active);
  }

  /** Opens the stream and plays it. Always ends in endTrack(), whatever happens. */
  private async runTrack(active: ActiveTrack): Promise<void> {
    let end: TrackEnd;
    try {
      const stream = await this.deps.media.openStream(active.track.videoId, active.abort.signal);
      if (active.abort.signal.aborted) {
        stream.destroy();
        end = { reason: 'stopped' };
      } else {
        const handle = this.driver.play(stream, this.deps.streamStartTimeoutMs);
        void handle.started.then(
          () => this.markPlaying(active),
          () => undefined, // a failed start also resolves `ended`, which is handled below
        );
        end = await handle.ended;
      }
    } catch (err) {
      end = { reason: 'error', error: err };
    }
    await this.endTrack(active, end);
  }

  private markPlaying(active: ActiveTrack): Promise<void> {
    return this.lock.runExclusive(() => {
      if (this.active !== active || this.currentState !== 'buffering') return;
      this.setState('playing');
      this.log.info({ trackId: active.track.id, title: active.track.title }, 'playback started');
    });
  }

  /** The single path for "a track is over". Ignored if the session moved on or died. */
  private endTrack(active: ActiveTrack, end: TrackEnd): Promise<void> {
    return this.lock.runExclusive(() => {
      if (this.active !== active) return;
      this.active = null;
      active.abort.abort(); // make sure no yt-dlp process outlives its track

      this.log.info(
        { trackId: active.track.id, reason: active.skipped ? 'skipped' : end.reason },
        'track ended',
      );
      if (end.reason === 'error' && !active.skipped) {
        this.log.warn({ err: end.error, trackId: active.track.id }, 'track failed');
        this.deps.announce(
          this.textChannelId,
          `Could not play ${active.track.title}: ${this.describeError(end.error)}`,
        );
      }
      this.advance();
    });
  }

  private advance(): void {
    this.setState('advancing');
    const next = advanceQueue(this.q);
    if (next) {
      this.beginCurrent();
      this.deps.announce(
        this.textChannelId,
        `Now playing: ${next.title} (${formatDuration(next.durationSec)})`,
      );
      return;
    }
    // Queue drained. Phase 4 replaces this with the LEAVE_GRACE_MS countdown (section 3.3).
    this.destroy('queue_empty');
  }

  private describeError(err: unknown): string {
    if (err instanceof MediaError) return userMessage(err.code);
    if (err instanceof VoiceJoinError) return err.message;
    return userMessage('INTERNAL');
  }

  private setState(next: SessionState): void {
    if (this.currentState === next) return;
    this.log.debug({ from: this.currentState, to: next }, 'session state');
    this.currentState = next;
  }
}
