import { describe, expect, it } from 'vitest';
import { parseYoutubeUrl } from '../src/media/urlParser.js';

const ID = 'dQw4w9WgXcQ';
const LIST = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

function video(input: string) {
  const r = parseYoutubeUrl(input);
  if (!r.ok || r.link.kind !== 'video') throw new Error(`expected video for ${input}`);
  return r.link;
}
function failure(input: string) {
  const r = parseYoutubeUrl(input);
  if (r.ok) throw new Error(`expected failure for ${input}`);
  return r.reason;
}

describe('video links', () => {
  it('parses a plain watch URL into the canonical form', () => {
    expect(video(`https://www.youtube.com/watch?v=${ID}`)).toEqual({
      kind: 'video',
      videoId: ID,
      url: `https://www.youtube.com/watch?v=${ID}`,
    });
  });

  it('drops tracking and time parameters', () => {
    const l = video(`https://www.youtube.com/watch?v=${ID}&t=30s&feature=share&si=abc`);
    expect(l.url).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it.each([
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
    `  https://www.youtube.com/watch?v=${ID}  `,
  ])('accepts %s', (input) => {
    expect(video(input).videoId).toBe(ID);
  });

  it('keeps a usable playlist id alongside the video', () => {
    expect(video(`https://www.youtube.com/watch?v=${ID}&list=${LIST}`).playlistId).toBe(LIST);
  });

  it('ignores mix and liked-videos lists on a watch link', () => {
    expect(
      video(`https://www.youtube.com/watch?v=${ID}&list=RDdQw4w9WgXcQ`).playlistId,
    ).toBeUndefined();
    expect(video(`https://www.youtube.com/watch?v=${ID}&list=LL`).playlistId).toBeUndefined();
  });
});

describe('playlist links', () => {
  it('parses a playlist URL', () => {
    expect(parseYoutubeUrl(`https://www.youtube.com/playlist?list=${LIST}`)).toEqual({
      ok: true,
      link: {
        kind: 'playlist',
        playlistId: LIST,
        url: `https://www.youtube.com/playlist?list=${LIST}`,
      },
    });
  });

  it('rejects unsupported playlist types', () => {
    expect(failure('https://www.youtube.com/playlist?list=LL')).toBe('unsupported_playlist');
    expect(failure('https://www.youtube.com/playlist?list=WL')).toBe('unsupported_playlist');
    expect(
      failure('https://www.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs'),
    ).toBe('unsupported_playlist');
  });

  it('rejects malformed or missing list ids', () => {
    expect(failure('https://www.youtube.com/playlist?list=abc')).toBe('invalid_url');
    expect(failure('https://www.youtube.com/playlist')).toBe('invalid_url');
    expect(failure('https://www.youtube.com/playlist?list=PL%20bad%20id%20here')).toBe(
      'invalid_url',
    );
  });
});

describe('rejected input', () => {
  it('rejects other hosts and look-alikes', () => {
    expect(failure(`https://vimeo.com/watch?v=${ID}`)).toBe('unsupported_host');
    expect(failure(`https://youtube.com.evil.com/watch?v=${ID}`)).toBe('unsupported_host');
    expect(failure(`https://notyoutube.com/watch?v=${ID}`)).toBe('unsupported_host');
    expect(failure(`https://evil.com/watch?v=${ID}&u=youtube.com`)).toBe('unsupported_host');
  });

  it('rejects credentials, ports and non-https schemes', () => {
    expect(failure(`https://www.youtube.com@evil.com/watch?v=${ID}`)).toBe('invalid_url');
    expect(failure(`https://user:pw@www.youtube.com/watch?v=${ID}`)).toBe('invalid_url');
    expect(failure(`https://www.youtube.com:8443/watch?v=${ID}`)).toBe('invalid_url');
    expect(failure(`http://www.youtube.com/watch?v=${ID}`)).toBe('invalid_url');
    expect(failure('javascript:alert(1)')).toBe('invalid_url');
    expect(failure('file:///etc/passwd')).toBe('invalid_url');
  });

  it('rejects bad video ids, including option-injection attempts', () => {
    expect(failure('https://www.youtube.com/watch?v=short')).toBe('invalid_url');
    expect(failure(`https://www.youtube.com/watch?v=${ID}extra`)).toBe('invalid_url');
    expect(failure('https://www.youtube.com/watch?v=--exec%20touch%20x')).toBe('invalid_url');
    expect(failure('https://www.youtube.com/watch?v=-oexploit123')).toBe('invalid_url');
  });

  it('rejects empty, junk and oversized input', () => {
    expect(failure('')).toBe('invalid_url');
    expect(failure('   ')).toBe('invalid_url');
    expect(failure('not a url')).toBe('invalid_url');
    expect(failure(`https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(3000)}`)).toBe(
      'invalid_url',
    );
  });

  it('reports pages without a video', () => {
    expect(failure('https://www.youtube.com/')).toBe('no_video');
    expect(failure('https://www.youtube.com/feed/subscriptions')).toBe('no_video');
  });
});
