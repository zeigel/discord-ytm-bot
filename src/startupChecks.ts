import { execFile } from 'node:child_process';
import type { Config } from './config.js';

export interface BinaryCheck {
  name: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export type Runner = (file: string, args: string[]) => Promise<string>;

/** Runs a binary with an argument array (never a shell string). */
const defaultRunner: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 90_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export async function checkBinary(
  name: string,
  file: string,
  args: string[],
  runner: Runner = defaultRunner,
): Promise<BinaryCheck> {
  try {
    const out = await runner(file, args);
    const version = out.split('\n')[0]?.trim() || 'unknown';
    return { name, ok: true, version };
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function runStartupChecks(
  config: Pick<Config, 'ytdlpPath' | 'ffmpegPath'>,
  runner: Runner = defaultRunner,
): Promise<BinaryCheck[]> {
  return Promise.all([
    checkBinary('yt-dlp', config.ytdlpPath, ['--version'], runner),
    checkBinary('ffmpeg', config.ffmpegPath, ['-version'], runner),
  ]);
}
