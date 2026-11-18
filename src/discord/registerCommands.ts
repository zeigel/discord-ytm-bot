import { REST, Routes } from 'discord.js';
import { ConfigError, loadConfig } from '../config.js';
import { commands } from './commands/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const body = commands.map((c) => c.data.toJSON());

  if (config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), { body });
    console.log(
      `Registered ${body.length} command(s) to dev guild ${config.devGuildId} (instant).`,
    );
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log(`Registered ${body.length} global command(s) (can take up to 1 hour to appear).`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('Command registration failed:', err);
  process.exit(1);
});
