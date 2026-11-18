import { describe, expect, it } from 'vitest';
import {
  addTrack,
  advanceQueue,
  clearQueue,
  createTrack,
  isFull,
  sizeOf,
} from '../src/core/queue.js';
import type { QueueState } from '../src/core/queue.js';
import type { Track } from '../src/core/types.js';

const requester = { id: 'u1', displayName: 'Ann' };

function track(n: number): Track {
  return createTrack(
    {
      videoId: `video${String(n).padStart(6, '0')}`,
      url: `https://www.youtube.com/watch?v=video${String(n).padStart(6, '0')}`,
      title: `Song ${n}`,
      durationSec: 100 + n,
      thumbnailUrl: undefined,
      isLive: false,
    },
    requester,
    1000 + n,
  );
}

const empty = (): QueueState => ({ current: null, queue: [] });

describe('createTrack', () => {
  it('copies the metadata, stamps the requester and time, and gives each track its own id', () => {
    const a = track(1);
    const b = track(1);
    expect(a.title).toBe('Song 1');
    expect(a.requestedBy).toEqual(requester);
    expect(a.addedAt).toBe(1001);
    expect(a.feedId).toBeUndefined();
    expect(a.id === b.id).toBe(false);
  });
});

describe('addTrack', () => {
  it('makes the first track the current one', () => {
    const state = empty();
    const r = addTrack(state, track(1), 5);
    expect(r).toEqual({ ok: true, startsNow: true, position: 0, size: 1 });
    expect(state.current?.title).toBe('Song 1');
    expect(state.queue).toHaveLength(0);
  });

  it('queues later tracks in FIFO order with 1-based positions', () => {
    const state = empty();
    addTrack(state, track(1), 5);
    const second = addTrack(state, track(2), 5);
    const third = addTrack(state, track(3), 5);
    expect(second).toEqual({ ok: true, startsNow: false, position: 1, size: 2 });
    expect(third).toEqual({ ok: true, startsNow: false, position: 2, size: 3 });
    expect(state.queue.map((t) => t.title)).toEqual(['Song 2', 'Song 3']);
  });

  it('counts the playing track against the cap and rejects the item after it', () => {
    const state = empty();
    for (let i = 1; i <= 3; i++) expect(addTrack(state, track(i), 3).ok).toBe(true);
    expect(isFull(state, 3)).toBe(true);
    expect(addTrack(state, track(4), 3)).toEqual({ ok: false, reason: 'full', max: 3 });
    expect(sizeOf(state)).toBe(3);
  });
});

describe('advanceQueue', () => {
  it('moves the head into current and returns it', () => {
    const state = empty();
    for (let i = 1; i <= 3; i++) addTrack(state, track(i), 5);
    expect(advanceQueue(state)?.title).toBe('Song 2');
    expect(state.current?.title).toBe('Song 2');
    expect(state.queue.map((t) => t.title)).toEqual(['Song 3']);
  });

  it('frees a slot, so a full queue accepts a track after an advance', () => {
    const state = empty();
    for (let i = 1; i <= 3; i++) addTrack(state, track(i), 3);
    advanceQueue(state);
    expect(addTrack(state, track(4), 3).ok).toBe(true);
  });

  it('returns null and clears current when nothing is waiting', () => {
    const state = empty();
    addTrack(state, track(1), 5);
    expect(advanceQueue(state)).toBeNull();
    expect(state.current).toBeNull();
  });
});

describe('clearQueue', () => {
  it('empties the current track and the queue', () => {
    const state = empty();
    for (let i = 1; i <= 3; i++) addTrack(state, track(i), 5);
    clearQueue(state);
    expect(sizeOf(state)).toBe(0);
    expect(state.current).toBeNull();
  });
});
