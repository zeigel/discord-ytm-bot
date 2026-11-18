import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { VoiceJoinError } from '../src/core/errors.js';
import { SessionManager } from '../src/core/SessionManager.js';
import type { EnqueueRequest } from '../src/core/SessionManager.js';
import type {
  PlayHandle,
  TrackEnd,
  VoiceDriver,
  VoiceDriverHandlers,
  VoiceTarget,
} from '../src/core/voice.js';
import type { AppLogger } from '../src/logger.js';
import { MediaError } from '../src/media/errors.js';
import type { MediaProvider, TrackMeta } from '../src/media/MediaProvider.js';
import { formatDuration } from '../src/utils/time.js';

const logger = pino({ level: 'silent' }) as unknown as AppLogger;

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakePlay {
  readonly handle: PlayHandle;
  private resolveStarted: () => void = () => undefined;
  private rejectStarted: (err: unknown) => void = () => undefined;
  private resolveEnded: (end: TrackEnd) => void = () => undefined;
  private done = false;

  constructor(readonly stream: Readable) {
    const started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    started.catch(() => undefined);
    const ended = new Promise<TrackEnd>((resolve) => {
      this.resolveEnded = resolve;
    });
    this.handle = { started, ended };
  }

  /** Audio is now audible. */
  start(): void {
    this.resolveStarted();
  }

  /** Ends the track; also rejects `started` if it never started, like the real driver. */
  end(end: TrackEnd): void {
    if (this.done) return;
    this.done = true;
    this.rejectStarted(end.reason === 'error' ? end.error : new Error('ended before start'));
    this.resolveEnded(end);
  }
}

class FakeDriver implements VoiceDriver {
  readonly plays: FakePlay[] = [];
  destroyed = false;
  destroyCalls = 0;
  stopCalls = 0;
  private resolveConnect: () => void = () => undefined;
  private rejectConnect: (err: unknown) => void = () => undefined;
  private readonly connected: Promise<void>;

  constructor(
    readonly target: VoiceTarget,
    readonly handlers: VoiceDriverHandlers,
    autoConnect: boolean,
  ) {
    this.connected = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    if (autoConnect) this.resolveConnect();
  }

  connect(): Promise<void> {
    return this.connected;
  }

  /** For tests that start with autoConnect off. */
  finishConnect(err?: unknown): void {
    if (err) this.rejectConnect(err);
    else this.resolveConnect();
  }

  play(stream: Readable): PlayHandle {
    const play = new FakePlay(stream);
    this.plays.push(play);
    return play.handle;
  }

  get lastPlay(): FakePlay {
    const last = this.plays[this.plays.length - 1];
    if (!last) throw new Error('nothing has played yet');
    return last;
  }

  stop(): void {
    this.stopCalls++;
    this.plays[this.plays.length - 1]?.end({ reason: 'stopped' });
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyCalls++;
    this.plays[this.plays.length - 1]?.end({ reason: 'stopped' });
  }
}

class FakeMedia implements MediaProvider {
  readonly opened: { videoId: string; signal: AbortSignal; stream: PassThrough }[] = [];
  readonly failOpen = new Set<string>();

  resolve(): Promise<TrackMeta> {
    return Promise.reject(new Error('resolve is not used by the session'));
  }

  openStream(videoId: string, signal: AbortSignal): Promise<Readable> {
    if (this.failOpen.has(videoId)) {
      return Promise.reject(new MediaError('UNAVAILABLE', 'video unavailable'));
    }
    const stream = new PassThrough();
    this.opened.push({ videoId, signal, stream });
    return Promise.resolve(stream);
  }
}

interface Harness {
  manager: SessionManager;
  media: FakeMedia;
  drivers: FakeDriver[];
  announcements: { channelId: string; message: string }[];
  driverFor(guildId: string): FakeDriver;
}

function setup(options: { maxQueueSize?: number; autoConnect?: boolean } = {}): Harness {
  const media = new FakeMedia();
  const drivers: FakeDriver[] = [];
  const announcements: { channelId: string; message: string }[] = [];
  const manager = new SessionManager({
    media,
    logger,
    maxQueueSize: options.maxQueueSize ?? 100,
    streamStartTimeoutMs: 1000,
    createDriver: (target, handlers) => {
      const driver = new FakeDriver(target, handlers, options.autoConnect ?? true);
      drivers.push(driver);
      return driver;
    },
    announce: (channelId, message) => {
      announcements.push({ channelId, message });
    },
  });
  return {
    manager,
    media,
    drivers,
    announcements,
    driverFor(guildId) {
      const driver = drivers.find((d) => d.target.guildId === guildId);
      if (!driver) throw new Error(`no driver for guild ${guildId}`);
      return driver;
    },
  };
}

function meta(title: string): TrackMeta {
  const videoId = title.padEnd(11, '_').slice(0, 11);
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    durationSec: 90,
    thumbnailUrl: undefined,
    isLive: false,
  };
}

function request(title: string, overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    meta: meta(title),
    requestedBy: { id: 'u1', displayName: 'Ann' },
    ...overrides,
  };
}

describe('SessionManager: queueing and the cap', () => {
  it('plays the first track and queues the next with a position', async () => {
    const h = setup();
    const first = await h.manager.enqueue(request('first'));
    expect(first.ok && first.startsNow).toBe(true);
    await flush();
    const session = h.manager.get('g1');
    expect(session?.state).toBe('buffering');
    h.driverFor('g1').lastPlay.start();
    await flush();
    expect(session?.state).toBe('playing');

    const second = await h.manager.enqueue(request('second'));
    expect(second.ok && second.startsNow).toBe(false);
    expect(second.ok && second.position).toBe(1);
    expect(session?.current?.title).toBe('first');
    expect(session?.queue.map((t) => t.title)).toEqual(['second']);
  });

  it('rejects the item after the cap, counting the playing track', async () => {
    const h = setup({ maxQueueSize: 3 });
    for (const title of ['a', 'b', 'c'])
      expect((await h.manager.enqueue(request(title))).ok).toBe(true);
    const fourth = await h.manager.enqueue(request('d'));
    expect(fourth).toEqual({ ok: false, reason: 'full', max: 3 });
    expect(h.manager.get('g1')?.size).toBe(3);
    expect(h.manager.get('g1')?.isFull).toBe(true);
  });

  it('keeps FIFO order under concurrent enqueue calls', async () => {
    const h = setup({ maxQueueSize: 50 });
    const titles = Array.from({ length: 20 }, (_, i) => `song${String(i).padStart(2, '0')}`);
    const outcomes = await Promise.all(titles.map((t) => h.manager.enqueue(request(t))));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const session = h.manager.get('g1');
    expect(session?.current?.title).toBe('song00');
    expect(session?.queue.map((t) => t.title)).toEqual(titles.slice(1));
    expect(outcomes.map((o) => (o.ok ? o.position : -1))).toEqual(titles.map((_, i) => i));
  });

  it('lets only one racing caller take the last slot', async () => {
    const h = setup({ maxQueueSize: 2 });
    await h.manager.enqueue(request('a'));
    const [x, y] = await Promise.all([
      h.manager.enqueue(request('x')),
      h.manager.enqueue(request('y')),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect(h.manager.get('g1')?.size).toBe(2);
  });

  it('creates one session when two first /play calls arrive together', async () => {
    const h = setup();
    const [a, b] = await Promise.all([
      h.manager.enqueue(request('a')),
      h.manager.enqueue(request('b')),
    ]);
    expect(h.drivers).toHaveLength(1);
    expect(a.ok && a.startsNow).toBe(true);
    expect(b.ok && b.startsNow).toBe(false);
    expect(h.manager.count).toBe(1);
  });

  it('refuses a request from a different voice channel and names the bot channel', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    const other = await h.manager.enqueue(request('b', { voiceChannelId: 'vc2' }));
    expect(other).toEqual({ ok: false, reason: 'wrong_channel', channelId: 'vc1' });
    expect(h.manager.get('g1')?.size).toBe(1);
  });
});

describe('GuildSession: playback flow', () => {
  it('auto-advances when a track finishes and announces the next one', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    await h.manager.enqueue(request('b'));
    await flush();
    h.driverFor('g1').lastPlay.start();
    h.driverFor('g1').plays[0]?.end({ reason: 'finished' });
    await flush();

    const session = h.manager.get('g1');
    expect(session?.current?.title).toBe('b');
    expect(session?.queue).toHaveLength(0);
    expect(h.driverFor('g1').plays).toHaveLength(2);
    expect(h.announcements).toEqual([
      { channelId: 'tc1', message: `Now playing: b (${formatDuration(90)})` },
    ]);
  });

  it('leaves and forgets the session when the last track ends', async () => {
    const h = setup();
    await h.manager.enqueue(request('only'));
    await flush();
    h.driverFor('g1').plays[0]?.end({ reason: 'finished' });
    await flush();
    expect(h.manager.get('g1')).toBeUndefined();
    expect(h.driverFor('g1').destroyed).toBe(true);
  });

  it('starts a fresh session for a /play after the old one ended', async () => {
    const h = setup();
    await h.manager.enqueue(request('one'));
    await flush();
    h.drivers[0]?.plays[0]?.end({ reason: 'finished' });
    await flush();
    const again = await h.manager.enqueue(request('two'));
    expect(again.ok && again.startsNow).toBe(true);
    expect(h.drivers).toHaveLength(2);
  });

  it('skip stops the track and advances exactly once', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    await h.manager.enqueue(request('b'));
    await h.manager.enqueue(request('c'));
    await flush();
    const session = h.manager.get('g1');
    if (!session) throw new Error('no session');
    h.driverFor('g1').lastPlay.start();
    await flush();

    const result = await session.skip();
    expect(result.ok && result.skipped.title).toBe('a');
    expect(result.ok && result.next?.title).toBe('b');
    await flush();

    expect(h.driverFor('g1').stopCalls).toBe(1);
    expect(h.driverFor('g1').plays).toHaveLength(2);
    expect(session.current?.title).toBe('b');
    expect(session.queue.map((t) => t.title)).toEqual(['c']);
    expect(h.announcements.filter((a) => a.message.startsWith('Could not'))).toHaveLength(0);
  });

  it('skipping the last track ends the session', async () => {
    const h = setup();
    await h.manager.enqueue(request('only'));
    await flush();
    const session = h.manager.get('g1');
    if (!session) throw new Error('no session');
    h.driverFor('g1').lastPlay.start();
    await flush();
    const result = await session.skip();
    expect(result.ok && result.next).toBeNull();
    await flush();
    expect(h.manager.get('g1')).toBeUndefined();
  });

  it('skip reports nothing playing once the session is gone', async () => {
    const h = setup();
    await h.manager.enqueue(request('only'));
    await flush();
    const session = h.manager.get('g1');
    if (!session) throw new Error('no session');
    session.destroy('stop_command');
    expect(await session.skip()).toEqual({ ok: false, reason: 'nothing_playing' });
  });

  it('announces a failed track and moves on to the next', async () => {
    const h = setup();
    await h.manager.enqueue(request('bad'));
    await h.manager.enqueue(request('good'));
    await flush();
    h.driverFor('g1').plays[0]?.end({
      reason: 'error',
      error: new MediaError('UNAVAILABLE', 'gone'),
    });
    await flush();

    const messages = h.announcements.map((a) => a.message);
    expect(messages[0]?.startsWith('Could not play bad: ')).toBe(true);
    expect(messages[1]).toBe(`Now playing: good (${formatDuration(90)})`);
    expect(h.manager.get('g1')?.current?.title).toBe('good');
  });

  it('treats a stream that cannot be opened as a failed track and moves on', async () => {
    const h = setup();
    h.media.failOpen.add(meta('bad').videoId);
    await Promise.all([h.manager.enqueue(request('bad')), h.manager.enqueue(request('good'))]);
    await flush();

    expect(h.announcements[0]?.message.startsWith('Could not play bad: ')).toBe(true);
    expect(h.manager.get('g1')?.current?.title).toBe('good');
    expect(h.driverFor('g1').plays).toHaveLength(1);
  });

  it('ignores a track ending after the session was destroyed', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    await h.manager.enqueue(request('b'));
    await flush();
    const session = h.manager.get('g1');
    if (!session) throw new Error('no session');

    // destroy() stops the driver, which ends track "a" afterwards. That late end must not
    // advance, announce, start "b", or destroy the session a second time.
    session.destroy('stop_command');
    await flush();

    expect(session.state).toBe('destroyed');
    expect(h.driverFor('g1').destroyCalls).toBe(1);
    expect(h.driverFor('g1').plays).toHaveLength(1);
    expect(h.announcements).toHaveLength(0);
  });
});

describe('GuildSession: joining and destroying', () => {
  it('reports a failed join, forgets the session and allows a retry', async () => {
    const h = setup({ autoConnect: false });
    const pending = h.manager.enqueue(request('a'));
    await flush();
    h.driverFor('g1').finishConnect(new VoiceJoinError('Could not connect in time'));
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('join_failed');
    expect(
      !outcome.ok && outcome.reason === 'join_failed' && outcome.error instanceof VoiceJoinError,
    ).toBe(true);
    expect(h.manager.get('g1')).toBeUndefined();
    expect(h.driverFor('g1').destroyed).toBe(true);

    const retry = setup().manager.enqueue(request('a'));
    expect((await retry).ok).toBe(true);
  });

  it('gives every waiting caller the join failure, not just the first', async () => {
    const h = setup({ autoConnect: false });
    const pending = Promise.all([h.manager.enqueue(request('a')), h.manager.enqueue(request('b'))]);
    await flush();
    h.driverFor('g1').finishConnect(new VoiceJoinError('Could not connect in time'));
    const [a, b] = await pending;
    expect(!a.ok && a.reason).toBe('join_failed');
    expect(!b.ok && b.reason).toBe('join_failed');
  });

  it('does not open a stream until the connection is ready', async () => {
    const h = setup({ autoConnect: false });
    const pending = h.manager.enqueue(request('a'));
    await flush();
    expect(h.media.opened).toHaveLength(0);
    h.driverFor('g1').finishConnect();
    await pending;
    await flush();
    expect(h.media.opened).toHaveLength(1);
  });

  it('destroyAll aborts the stream, stops the driver and clears the queue', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    await h.manager.enqueue(request('b'));
    await flush();
    const opened = h.media.opened[0];
    expect(opened?.signal.aborted).toBe(false);

    h.manager.destroyAll('shutdown');
    await flush();
    expect(opened?.signal.aborted).toBe(true);
    expect(h.driverFor('g1').destroyed).toBe(true);
    expect(h.manager.count).toBe(0);
    expect(h.driverFor('g1').plays).toHaveLength(1); // the queued track never started
  });

  it('forgets the session when the voice connection is lost', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    await flush();
    h.driverFor('g1').handlers.onDisconnected();
    await flush();
    expect(h.manager.get('g1')).toBeUndefined();
    expect(h.driverFor('g1').destroyed).toBe(true);
  });

  it('aborts the stream of a track once it has ended', async () => {
    const h = setup();
    await h.manager.enqueue(request('a'));
    await h.manager.enqueue(request('b'));
    await flush();
    const first = h.media.opened[0];
    h.driverFor('g1').plays[0]?.end({ reason: 'finished' });
    await flush();
    expect(first?.signal.aborted).toBe(true);
    expect(h.media.opened[1]?.signal.aborted).toBe(false);
  });
});

describe('per-guild isolation', () => {
  it('keeps queues, caps and playback independent', async () => {
    const h = setup({ maxQueueSize: 2 });
    await h.manager.enqueue(request('a1', { guildId: 'g1', voiceChannelId: 'vc1' }));
    await h.manager.enqueue(request('a2', { guildId: 'g1', voiceChannelId: 'vc1' }));
    const full = await h.manager.enqueue(request('a3', { guildId: 'g1', voiceChannelId: 'vc1' }));
    expect(!full.ok && full.reason).toBe('full');

    // Guild 2 has its own, empty queue and its own cap.
    const b1 = await h.manager.enqueue(
      request('b1', { guildId: 'g2', voiceChannelId: 'vcX', textChannelId: 'tc2' }),
    );
    expect(b1.ok && b1.startsNow).toBe(true);
    await flush();

    // Finishing guild 1's track advances guild 1 only.
    h.driverFor('g1').plays[0]?.end({ reason: 'finished' });
    await flush();
    expect(h.manager.get('g1')?.current?.title).toBe('a2');
    expect(h.manager.get('g2')?.current?.title).toBe('b1');
    expect(h.driverFor('g2').plays).toHaveLength(1);

    // Ending guild 2's only track destroys guild 2 only, and announces nowhere near guild 1.
    h.driverFor('g2').plays[0]?.end({ reason: 'finished' });
    await flush();
    expect(h.manager.get('g2')).toBeUndefined();
    expect(h.manager.get('g1')).toBeDefined();
    expect(h.driverFor('g1').destroyed).toBe(false);
    expect(h.announcements.every((a) => a.channelId === 'tc1')).toBe(true);
  });
});
