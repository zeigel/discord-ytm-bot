import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import { MediaError, classifyYtDlpError } from './errors.js';
import type { MediaProvider, TrackMeta } from './MediaProvider.js';
import { canonicalVideoUrl } from './urlParser.js';

const MAX_STDOUT_CHARS = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const KILL_GRACE_MS = 2000;

const infoSchema = z.object({
  id: z.string(),
  title: z.string(),
  duration: z.number().nullish(),
  is_live: z.boolean().nullish(),
  live_status: z.string().nullish(),
  thumbnail: z.string().nullish(),
});

export interface YtDlpProviderOptions {
  ytdlpPath: string;
  cookiesFile: string | undefined;
  resolveTimeoutMs: number;
  logger: AppLogger;
}

/** SIGTERM first, then SIGKILL if the process has not exited after a short grace period. */
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCapture(file: string, args: string[], signal: AbortSignal): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX_STDOUT_CHARS) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d;
    });
    const onAbort = (): void => {
      killChild(child);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code });
    });
  });
}

export class YtDlpProvider implements MediaProvider {
  private readonly opts: YtDlpProviderOptions;

  constructor(opts: YtDlpProviderOptions) {
    this.opts = opts;
  }

  private cookieArgs(): string[] {
    return this.opts.cookiesFile ? ['--cookies', this.opts.cookiesFile] : [];
  }

  async resolve(videoId: string, signal?: AbortSignal): Promise<TrackMeta> {
    const url = canonicalVideoUrl(videoId);
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      ...this.cookieArgs(),
      url,
    ];
    const timeout = AbortSignal.timeout(this.opts.resolveTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let result: CaptureResult;
    try {
      result = await runCapture(this.opts.ytdlpPath, args, combined);
    } catch (err) {
      if (timeout.aborted) throw new MediaError('TIMEOUT', 'yt-dlp timed out while resolving');
      if (signal?.aborted) throw err;
      throw new MediaError('INTERNAL', `Could not run yt-dlp: ${String(err)}`, { cause: err });
    }

    if (result.code !== 0) {
      const code = classifyYtDlpError(result.stderr);
      this.opts.logger.warn(
        { videoId, exitCode: result.code, stderr: result.stderr.slice(-500), code },
        'yt-dlp resolve failed',
      );
      throw new MediaError(code, `yt-dlp exited with code ${String(result.code)}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch (err) {
      throw new MediaError('INTERNAL', 'yt-dlp returned invalid JSON', { cause: err });
    }
    const parsed = infoSchema.safeParse(json);
    if (!parsed.success) throw new MediaError('INTERNAL', 'yt-dlp returned unexpected metadata');

    const d = parsed.data;
    const isLive =
      d.is_live === true || d.live_status === 'is_live' || d.live_status === 'is_upcoming';
    return {
      videoId: d.id,
      url: canonicalVideoUrl(d.id),
      title: d.title,
      durationSec: Math.round(d.duration ?? 0),
      thumbnailUrl: d.thumbnail ?? undefined,
      isLive,
    };
  }

  openStream(videoId: string, signal: AbortSignal): Promise<Readable> {
    const url = canonicalVideoUrl(videoId);
    const args = [
      '-f',
      'bestaudio[acodec=opus]/bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '-o',
      '-',
      ...this.cookieArgs(),
      url,
    ];
    const log = this.opts.logger.child({ videoId });
    const child = spawn(this.opts.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d;
    });

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      killChild(child);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      child.stdout.destroy(new MediaError('INTERNAL', `Could not start yt-dlp: ${err.message}`));
    });

    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      log.debug({ exitCode: code, aborted }, 'yt-dlp stream process closed');
      if (code !== 0 && !aborted && !child.stdout.destroyed) {
        const mediaCode = classifyYtDlpError(stderr);
        log.warn({ exitCode: code, stderr: stderr.slice(-500), mediaCode }, 'yt-dlp stream failed');
        child.stdout.destroy(new MediaError(mediaCode, `yt-dlp exited with code ${String(code)}`));
      }
    });

    return Promise.resolve(child.stdout);
  }
}
