export interface Requester {
  id: string;
  displayName: string;
}

export interface Track {
  /** Unique per queue entry (the same video queued twice gets two ids). */
  id: string;
  /** 11-character YouTube id. */
  videoId: string;
  /** Canonical watch URL. */
  url: string;
  title: string;
  durationSec: number;
  thumbnailUrl?: string | undefined;
  requestedBy: Requester;
  addedAt: number;
  /** Set when the track came from a PlaylistFeed (Phase 3b). */
  feedId?: string | undefined;
}

/** Flat playlist entry, fetched once (section 7.8). Unused until Phase 3b. */
export interface PlaylistEntry {
  videoId: string;
  title: string;
  durationSec: number | null;
}

/** Not-yet-queued entries of one playlist (section 7.8). Unused until Phase 3b. */
export interface PlaylistFeed {
  id: string;
  playlistId: string;
  title: string;
  requestedBy: Requester;
  entries: PlaylistEntry[];
  /** Index of the next entry to queue. */
  cursor: number;
  /** This feed's tracks now in the queue (not the playing one). */
  waiting: number;
}

export type SessionState =
  'connecting' | 'idle' | 'buffering' | 'playing' | 'advancing' | 'destroyed';

/** Why a session ended. Phase 4 adds the lifecycle reasons (only bots left, kicked, moved...). */
export type DestroyReason =
  'queue_empty' | 'join_failed' | 'disconnected' | 'shutdown' | 'stop_command';
