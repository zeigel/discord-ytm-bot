import { ping } from './ping.js';
import { play } from './play.js';
import type { Command } from './types.js';

export const commands: Command[] = [ping, play];

export const commandMap = new Map<string, Command>(commands.map((c) => [c.data.name, c]));
