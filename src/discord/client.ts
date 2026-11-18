import { Client, GatewayIntentBits } from 'discord.js';

/** Only non-privileged intents: slash commands need no message content. */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}
