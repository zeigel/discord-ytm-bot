import { describe, expect, it } from 'vitest';
import { MediaError, classifyYtDlpError, userMessage } from '../src/media/errors.js';

describe('classifyYtDlpError', () => {
  it.each([
    [
      'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate',
      'AGE_RESTRICTED',
    ],
    [
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
      'BLOCKED',
    ],
    ['ERROR: [youtube] abc: Sign in to confirm you\u2019re not a bot', 'BLOCKED'],
    ['ERROR: unable to download: HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
    ['ERROR: [youtube] abc: This live event will begin in 2 hours.', 'LIVE_UNSUPPORTED'],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", 'UNAVAILABLE'],
    ['ERROR: [youtube] abc: Video unavailable', 'UNAVAILABLE'],
    [
      'ERROR: [youtube] abc: The uploader has not made this video available in your country',
      'UNAVAILABLE',
    ],
    ['something odd happened', 'INTERNAL'],
    ['', 'INTERNAL'],
  ])('maps %j to %s', (stderr, code) => {
    expect(classifyYtDlpError(stderr)).toBe(code);
  });
});

describe('MediaError', () => {
  it('carries its code and has a user message for every code', () => {
    const e = new MediaError('TIMEOUT', 'x');
    expect(e.code).toBe('TIMEOUT');
    expect(e).toBeInstanceOf(Error);
    expect(userMessage('TIMEOUT').length).toBeGreaterThan(0);
  });
});
