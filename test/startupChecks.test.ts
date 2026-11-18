import { describe, expect, it } from 'vitest';
import { checkBinary, runStartupChecks } from '../src/startupChecks.js';

describe('startup checks', () => {
  it('reports the first line of output as the version', async () => {
    const runner = async () => 'ffmpeg version 7.1 Copyright\nbuilt with clang\n';
    const r = await checkBinary('ffmpeg', 'ffmpeg', ['-version'], runner);
    expect(r).toEqual({ name: 'ffmpeg', ok: true, version: 'ffmpeg version 7.1 Copyright' });
  });

  it('reports failure when the binary cannot run', async () => {
    const runner = async () => {
      throw new Error('spawn yt-dlp ENOENT');
    };
    const r = await checkBinary('yt-dlp', 'yt-dlp', ['--version'], runner);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOENT');
  });

  it('checks both binaries using the configured paths', async () => {
    const calls: string[] = [];
    const runner = async (file: string) => {
      calls.push(file);
      return '1.0\n';
    };
    const results = await runStartupChecks(
      { ytdlpPath: '/x/yt-dlp', ffmpegPath: '/x/ffmpeg' },
      runner,
    );
    expect(calls.sort()).toEqual(['/x/ffmpeg', '/x/yt-dlp']);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
