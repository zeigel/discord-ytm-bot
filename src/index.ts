import { ConfigError, loadConfig } from './config.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createLogger } from './logger.js';
import { runStartupChecks } from './startupChecks.js';
import { createClient } from './discord/client.js';
import { registerReady } from './discord/events/ready.js';
import { registerInteractionCreate } from './discord/events/interactionCreate.js';
import { YtDlpProvider } from './media/YtDlpProvider.js';
import { SessionManager } from './core/SessionManager.js';
import { createAnnouncer } from './discord/announce.js';
import { createDiscordVoiceDriverFactory } from './discord/voiceDriver.js';

/** From Phase 1 on, playback needs both binaries, so a missing one is fatal. */
const BINARIES_REQUIRED = true;

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);

  const checks = await runStartupChecks(config);
  for (const c of checks) {
    if (c.ok) logger.info({ binary: c.name, version: c.version }, 'binary found');
    else logger.warn({ binary: c.name, error: c.error }, 'binary missing or not working');
  }
  if (BINARIES_REQUIRED && checks.some((c) => !c.ok)) {
    logger.fatal('required binaries are missing, exiting (install yt-dlp and ffmpeg)');
    process.exit(1);
  }

  if (config.mediaProvider === 'remote') {
    logger.fatal('MEDIA_PROVIDER=remote is not implemented yet, use local');
    process.exit(1);
  }

  const media = new YtDlpProvider({
    ytdlpPath: config.ytdlpPath,
    cookiesFile: config.ytdlpCookiesFile,
    resolveTimeoutMs: config.resolveTimeoutMs,
    logger,
  });

  const client = createClient();
  const sessions = new SessionManager({
    media,
    logger,
    maxQueueSize: config.maxQueueSize,
    streamStartTimeoutMs: config.streamStartTimeoutMs,
    createDriver: createDiscordVoiceDriverFactory(client, logger),
    announce: createAnnouncer(client, logger),
  });
  const ctx: AppContext = { config, logger, media, sessions };

  registerReady(client, logger);
  registerInteractionCreate(client, ctx);

  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled rejection'),
  );
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    sessions.destroyAll('shutdown');
    process.exit(1);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    sessions.destroyAll('shutdown');
    await client.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.discordToken);
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
