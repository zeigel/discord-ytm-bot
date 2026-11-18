import type { Config } from './config.js';
import type { SessionManager } from './core/SessionManager.js';
import type { AppLogger } from './logger.js';
import type { MediaProvider } from './media/MediaProvider.js';

/** Everything commands and event handlers need, built once in index.ts. */
export interface AppContext {
  config: Config;
  logger: AppLogger;
  media: MediaProvider;
  sessions: SessionManager;
}
