import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { AppLogger } from '../../logger.js';

export function registerReady(client: Client, logger: AppLogger): void {
  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'bot is ready');
  });
}
