import type { Client } from 'discord.js';
import type { AppLogger } from '../logger.js';

/**
 * Posts public messages (now playing, track failed) to a text channel. Never throws.
 * Mentions are disabled because track titles are untrusted text and must not ping anyone.
 */
export function createAnnouncer(
  client: Client,
  logger: AppLogger,
): (channelId: string, content: string) => void {
  return (channelId, content) => {
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isSendable()) {
      logger.debug({ channelId }, 'announce skipped: channel not cached or not sendable');
      return;
    }
    channel.send({ content, allowedMentions: { parse: [] } }).catch((err: unknown) => {
      logger.warn({ err, channelId }, 'announce failed');
    });
  };
}
