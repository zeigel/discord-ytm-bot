import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';

/** Temporary smoke-test command, removed or kept as a health check later. */
export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive'),
  async execute(interaction) {
    const latency = Math.round(interaction.client.ws.ping);
    await interaction.reply({
      content: `Pong! Gateway latency: ${latency} ms`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
