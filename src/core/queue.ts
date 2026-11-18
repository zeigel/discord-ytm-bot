/**
 * Pure queue operations and capacity rules. No I/O and no timers, so it is unit-testable on its own.
 * These functions mutate the QueueState they are given; GuildSession owns the one real instance and
 * only calls them while holding its lock.
 */
import { randomUUID } from 'node:crypto';
import type { TrackMeta } from '../media/MediaProvider.js';
import type { Requester, Track } from './types.js';

export interface QueueState {
  /** The track playing, or about to play. Invariant: if this is null, `queue` is empty. */
  current: Track | null;
  /** Waiting tracks, FIFO. */
  queue: Track[];
}

export function createTrack(
  meta: TrackMeta,
  requestedBy: Requester,
  now: number = Date.now(),
): Track {
  return {
    id: randomUUID(),
    videoId: meta.videoId,
    url: meta.url,
    title: meta.title,
    durationSec: meta.durationSec,
    thumbnailUrl: meta.thumbnailUrl,
    requestedBy,
    addedAt: now,
  };
}

/** Playing track plus waiting tracks. This is the number the cap applies to. */
export function sizeOf(state: QueueState): number {
  return (state.current ? 1 : 0) + state.queue.length;
}

export function isFull(state: QueueState, max: number): boolean {
  return sizeOf(state) >= max;
}

export type AddResult =
  | {
      ok: true;
      /** True when nothing was playing, so this track is the one that plays now. */
      startsNow: boolean;
      /** 0 when it starts now, otherwise 1 for "plays next", 2 for the one after, and so on. */
      position: number;
      /** Playing plus waiting, after the add. */
      size: number;
    }
  | { ok: false; reason: 'full'; max: number };

export function addTrack(state: QueueState, track: Track, max: number): AddResult {
  if (isFull(state, max)) return { ok: false, reason: 'full', max };
  if (state.current === null) {
    state.current = track;
    return { ok: true, startsNow: true, position: 0, size: sizeOf(state) };
  }
  state.queue.push(track);
  return { ok: true, startsNow: false, position: state.queue.length, size: sizeOf(state) };
}

/** Makes the head of the queue the current track. Returns it, or null when nothing is left. */
export function advanceQueue(state: QueueState): Track | null {
  const next = state.queue.shift() ?? null;
  state.current = next;
  return next;
}

export function clearQueue(state: QueueState): void {
  state.current = null;
  state.queue.length = 0;
}
