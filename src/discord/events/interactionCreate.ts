import { Events, MessageFlags } from 'discord.js';
import type { Client } from 'discord.js';
import type { AppContext } from '../../context.js';
import { commandMap } from '../commands/index.js';

export function registerInteractionCreate(client: Client, ctx: AppContext): void {
  const { logger } = ctx;
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) {
      logger.warn({ command: interaction.commandName }, 'unknown command');
      return;
    }

    try {
      await command.execute(interaction, ctx);
    } catch (err) {
      logger.error(
        { err, command: interaction.commandName, guildId: interaction.guildId },
        'command failed',
      );
      const payload = {
        content: 'Something went wrong running that command.',
        flags: MessageFlags.Ephemeral,
      } as const;
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch (replyErr) {
        logger.error({ err: replyErr }, 'failed to send error reply');
      }
    }
  });
}
