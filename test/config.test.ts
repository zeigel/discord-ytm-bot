import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

const base = { DISCORD_TOKEN: 'token', DISCORD_CLIENT_ID: '123456789012345678' };

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    const c = parseConfig(base);
    expect(c.maxQueueSize).toBe(100);
    expect(c.maxTrackDurationSec).toBe(7200);
    expect(c.leaveGraceMs).toBe(2000);
    expect(c.ytdlpPath).toBe('yt-dlp');
    expect(c.mediaProvider).toBe('local');
    expect(c.logLevel).toBe('info');
  });

  it('treats empty strings as unset', () => {
    const c = parseConfig({ ...base, DEV_GUILD_ID: '', YTDLP_COOKIES_FILE: '  ' });
    expect(c.devGuildId).toBeUndefined();
    expect(c.ytdlpCookiesFile).toBeUndefined();
  });

  it('coerces numeric strings', () => {
    expect(parseConfig({ ...base, MAX_QUEUE_SIZE: '5' }).maxQueueSize).toBe(5);
  });

  it('rejects a missing token and names the variable', () => {
    expect(() => parseConfig({ DISCORD_CLIENT_ID: base.DISCORD_CLIENT_ID })).toThrow(ConfigError);
    expect(() => parseConfig({ DISCORD_CLIENT_ID: base.DISCORD_CLIENT_ID })).toThrow(
      /DISCORD_TOKEN/,
    );
  });

  it('rejects a malformed client id', () => {
    expect(() => parseConfig({ ...base, DISCORD_CLIENT_ID: 'abc' })).toThrow(/DISCORD_CLIENT_ID/);
  });

  it('requires resolver settings when MEDIA_PROVIDER=remote', () => {
    expect(() => parseConfig({ ...base, MEDIA_PROVIDER: 'remote' })).toThrow(/RESOLVER_URL/);
  });

  it('never echoes the token in an error', () => {
    try {
      parseConfig({ DISCORD_TOKEN: 'super-secret', DISCORD_CLIENT_ID: 'bad' });
    } catch (err) {
      expect(String(err)).not.toContain('super-secret');
    }
  });
});
