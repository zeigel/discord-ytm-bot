import { pino } from 'pino';
import type { Logger } from 'pino';

export type AppLogger = Logger;

export function createLogger(level: string): AppLogger {
  const pretty = Boolean(process.stdout.isTTY) && process.env['NODE_ENV'] !== 'production';
  return pino({
    level,
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
  });
}
