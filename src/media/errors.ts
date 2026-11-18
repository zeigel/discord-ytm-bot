export type MediaErrorCode =
  | 'INVALID_URL'
  | 'UNAVAILABLE'
  | 'AGE_RESTRICTED'
  | 'LIVE_UNSUPPORTED'
  | 'TOO_LONG'
  | 'RATE_LIMITED'
  | 'BLOCKED'
  | 'TIMEOUT'
  | 'INTERNAL';

export class MediaError extends Error {
  override name = 'MediaError';
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Maps yt-dlp's stderr text to an error code. Order matters: age check comes before bot check. */
export function classifyYtDlpError(stderr: string): MediaErrorCode {
  const s = stderr.toLowerCase();
  if (
    s.includes('confirm your age') ||
    s.includes('age-restricted') ||
    s.includes('age restricted')
  ) {
    return 'AGE_RESTRICTED';
  }
  if (s.includes('not a bot') || s.includes('sign in to confirm')) return 'BLOCKED';
  if (s.includes('http error 429') || s.includes('too many requests')) return 'RATE_LIMITED';
  if (s.includes('live event will begin') || s.includes('premieres in') || s.includes('is live')) {
    return 'LIVE_UNSUPPORTED';
  }
  if (
    s.includes('private video') ||
    s.includes('video unavailable') ||
    s.includes('this video is not available') ||
    s.includes('has been removed') ||
    s.includes('members-only') ||
    s.includes('who has blocked it') ||
    s.includes('in your country')
  ) {
    return 'UNAVAILABLE';
  }
  return 'INTERNAL';
}

const MESSAGES: Record<MediaErrorCode, string> = {
  INVALID_URL: 'That does not look like a valid YouTube link.',
  UNAVAILABLE: 'That video is unavailable (private, deleted or blocked in this region).',
  AGE_RESTRICTED: 'That video is age-restricted, so I cannot play it.',
  LIVE_UNSUPPORTED: 'Live streams are not supported.',
  TOO_LONG: 'That video is longer than the allowed maximum.',
  RATE_LIMITED: 'YouTube is rate limiting me right now. Try again in a few minutes.',
  BLOCKED:
    'YouTube blocked the request from this host. The bot owner may need to configure cookies.',
  TIMEOUT: 'YouTube took too long to respond. Try again.',
  INTERNAL: 'Something went wrong while fetching that video.',
};

export function userMessage(code: MediaErrorCode): string {
  return MESSAGES[code];
}
