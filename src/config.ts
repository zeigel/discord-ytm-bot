import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17 to 20 digits)');

const envSchema = z
  .object({
    DISCORD_TOKEN: z.string().min(1, 'is required'),
    DISCORD_CLIENT_ID: snowflake,
    DEV_GUILD_ID: snowflake.optional(),
    MAX_QUEUE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
    MAX_TRACK_DURATION_SEC: z.coerce.number().int().min(10).default(7200),
    MAX_TRACKS_PER_USER: z.coerce.number().int().min(0).default(0),
    LEAVE_GRACE_MS: z.coerce.number().int().min(0).default(2000),
    RESOLVE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
    STREAM_START_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
    YTDLP_PATH: z.string().min(1).default('yt-dlp'),
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    YTDLP_COOKIES_FILE: z.string().min(1).optional(),
    MEDIA_PROVIDER: z.enum(['local', 'remote']).default('local'),
    RESOLVER_URL: z.url().optional(),
    RESOLVER_TOKEN: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .refine((e) => e.MEDIA_PROVIDER !== 'remote' || e.RESOLVER_URL !== undefined, {
    message: 'is required when MEDIA_PROVIDER=remote',
    path: ['RESOLVER_URL'],
  })
  .refine((e) => e.MEDIA_PROVIDER !== 'remote' || e.RESOLVER_TOKEN !== undefined, {
    message: 'is required when MEDIA_PROVIDER=remote',
    path: ['RESOLVER_TOKEN'],
  });

export interface Config {
  discordToken: string;
  clientId: string;
  devGuildId: string | undefined;
  maxQueueSize: number;
  maxTrackDurationSec: number;
  maxTracksPerUser: number;
  leaveGraceMs: number;
  resolveTimeoutMs: number;
  streamStartTimeoutMs: number;
  ytdlpPath: string;
  ffmpegPath: string;
  ytdlpCookiesFile: string | undefined;
  mediaProvider: 'local' | 'remote';
  resolverUrl: string | undefined;
  resolverToken: string | undefined;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Pure function: validates an env-like object. Empty strings count as unset. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  return {
    discordToken: e.DISCORD_TOKEN,
    clientId: e.DISCORD_CLIENT_ID,
    devGuildId: e.DEV_GUILD_ID,
    maxQueueSize: e.MAX_QUEUE_SIZE,
    maxTrackDurationSec: e.MAX_TRACK_DURATION_SEC,
    maxTracksPerUser: e.MAX_TRACKS_PER_USER,
    leaveGraceMs: e.LEAVE_GRACE_MS,
    resolveTimeoutMs: e.RESOLVE_TIMEOUT_MS,
    streamStartTimeoutMs: e.STREAM_START_TIMEOUT_MS,
    ytdlpPath: e.YTDLP_PATH,
    ffmpegPath: e.FFMPEG_PATH,
    ytdlpCookiesFile: e.YTDLP_COOKIES_FILE,
    mediaProvider: e.MEDIA_PROVIDER,
    resolverUrl: e.RESOLVER_URL,
    resolverToken: e.RESOLVER_TOKEN,
    logLevel: e.LOG_LEVEL,
  };
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
