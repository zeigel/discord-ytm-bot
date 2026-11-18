# discord-yt-bot

Discord bot that joins a voice channel and plays the audio of YouTube links, with a per-server queue (max 20).
See the project proposal for the full plan. This repo is at **Phase 0: bootstrap**.

## Setup

```bash
nvm use            # reads .nvmrc (Node 22)
npm install
cp .env.example .env   # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DEV_GUILD_ID
```

### Discord application

1. Developer Portal, New Application, copy the **Application ID** into `DISCORD_CLIENT_ID`.
2. Bot tab, Reset Token, copy it into `DISCORD_TOKEN` (never commit it). No privileged intents are needed.
3. Invite the bot (replace `CLIENT_ID`):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=3146752`
4. Put your test server ID in `DEV_GUILD_ID` so commands appear instantly.

## Scripts

| Command                           | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `npm run register`                | Register slash commands (guild-only if `DEV_GUILD_ID` is set) |
| `npm run dev`                     | Run with auto-reload                                          |
| `npm run build` / `npm start`     | Compile to `dist/` and run it                                 |
| `npm run typecheck`               | TypeScript check without emitting                             |
| `npm run lint` / `npm run format` | ESLint / Prettier                                             |
| `npm test`                        | Run unit tests (vitest)                                       |

## External binaries

`yt-dlp` and `ffmpeg` are checked at startup. In Phase 0 a missing binary only logs a warning; from Phase 1 it is fatal.
