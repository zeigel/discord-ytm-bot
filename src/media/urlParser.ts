/**
 * Pure YouTube link parser. Anything that reaches yt-dlp must come out of here:
 * only a validated 11-character video id or playlist id is ever used, and the
 * URL passed on is rebuilt from it, so user text never reaches a command line.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);
const SHORT_HOST = 'youtu.be';
const MAX_INPUT_LENGTH = 2048;

export type ParseFailure = 'invalid_url' | 'unsupported_host' | 'no_video' | 'unsupported_playlist';

export interface VideoLink {
  kind: 'video';
  videoId: string;
  /** Canonical watch URL. */
  url: string;
  /** Present when the link also carried a usable playlist id. */
  playlistId?: string;
}

export interface PlaylistLink {
  kind: 'playlist';
  playlistId: string;
  /** Canonical playlist URL. */
  url: string;
}

export type ParsedLink = VideoLink | PlaylistLink;
export type ParseResult = { ok: true; link: ParsedLink } | { ok: false; reason: ParseFailure };

export const canonicalVideoUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

export const canonicalPlaylistUrl = (playlistId: string): string =>
  `https://www.youtube.com/playlist?list=${playlistId}`;

type PlaylistIdKind = 'ok' | 'unsupported' | 'invalid';

/** Liked videos (LL), Watch later (WL) and auto-generated mixes (RD...) are not supported. */
function classifyPlaylistId(id: string): PlaylistIdKind {
  if (id === 'LL' || id === 'WL') return 'unsupported';
  if (!PLAYLIST_ID.test(id)) return 'invalid';
  if (id.startsWith('RD')) return 'unsupported';
  return 'ok';
}

const fail = (reason: ParseFailure): ParseResult => ({ ok: false, reason });

export function parseYoutubeUrl(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return fail('invalid_url');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail('invalid_url');
  }

  if (url.protocol !== 'https:') return fail('invalid_url');
  if (url.username !== '' || url.password !== '' || url.port !== '') return fail('invalid_url');

  const host = url.hostname.toLowerCase();
  const isShort = host === SHORT_HOST;
  if (!isShort && !YOUTUBE_HOSTS.has(host)) return fail('unsupported_host');

  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];

  let videoId: string | undefined;
  if (isShort) videoId = first;
  else if (first === 'watch') videoId = url.searchParams.get('v') ?? undefined;
  else if (first === 'shorts' || first === 'embed') videoId = segments[1];

  const list = url.searchParams.get('list') ?? undefined;
  const listKind = list === undefined ? undefined : classifyPlaylistId(list);

  if (videoId !== undefined) {
    if (!VIDEO_ID.test(videoId)) return fail('invalid_url');
    const link: VideoLink = { kind: 'video', videoId, url: canonicalVideoUrl(videoId) };
    if (list !== undefined && listKind === 'ok') link.playlistId = list;
    return { ok: true, link };
  }

  if (!isShort && first === 'playlist') {
    if (list === undefined || listKind === 'invalid') return fail('invalid_url');
    if (listKind === 'unsupported') return fail('unsupported_playlist');
    return {
      ok: true,
      link: { kind: 'playlist', playlistId: list, url: canonicalPlaylistUrl(list) },
    };
  }

  return fail('no_video');
}
