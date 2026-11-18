/**
 * The real VoiceDriver, built on @discordjs/voice. The join, reconnect and demuxProbe logic is the
 * Phase 1 code from singlePlayback.ts, reshaped to fit the VoiceDriver seam (src/core/voice.ts).
 */
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Client, Guild } from 'discord.js';
import type { Readable } from 'node:stream';
import { VoiceJoinError } from '../core/errors.js';
import type {
  PlayHandle,
  TrackEnd,
  VoiceDriver,
  VoiceDriverFactory,
  VoiceDriverHandlers,
  VoiceTarget,
} from '../core/voice.js';
import type { AppLogger } from '../logger.js';
import { MediaError } from '../media/errors.js';

const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_WINDOW_MS = 5_000;

/** AudioPlayerError wraps the original error; unwrap it so MediaError codes survive. */
function unwrap(err: unknown): unknown {
  const original = (err as { original?: unknown }).original;
  return original instanceof Error ? original : err;
}

interface ActivePlay {
  stream: Readable;
  done: boolean;
  stopRequested: boolean;
  startedSettled: boolean;
  /** Last error emitted by the source stream (for example a MediaError from yt-dlp). */
  sourceError: unknown;
  resolveStarted: () => void;
  rejectStarted: (err: unknown) => void;
  resolveEnded: (end: TrackEnd) => void;
}

function createPlay(stream: Readable): { play: ActivePlay; handle: PlayHandle } {
  let resolveStarted: () => void = () => undefined;
  let rejectStarted: (err: unknown) => void = () => undefined;
  let resolveEnded: (end: TrackEnd) => void = () => undefined;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const ended = new Promise<TrackEnd>((resolve) => {
    resolveEnded = resolve;
  });
  started.catch(() => undefined); // never leave this rejection unhandled
  return {
    play: {
      stream,
      done: false,
      stopRequested: false,
      startedSettled: false,
      sourceError: undefined,
      resolveStarted,
      rejectStarted,
      resolveEnded,
    },
    handle: { started, ended },
  };
}

class DiscordVoiceDriver implements VoiceDriver {
  private readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  private readonly log: AppLogger;
  private activePlay: ActivePlay | null = null;
  private destroyed = false;

  constructor(guild: Guild, target: VoiceTarget, handlers: VoiceDriverHandlers, log: AppLogger) {
    this.log = log;
    this.connection = joinVoiceChannel({
      channelId: target.channelId,
      guildId: target.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.player = createAudioPlayer();

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.watchDisconnect(handlers);
    });
    this.player.on('error', (err) => {
      this.log.error({ err }, 'audio player error');
      const play = this.activePlay;
      if (play) this.finishPlay(play, { reason: 'error', error: unwrap(err) });
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      const play = this.activePlay;
      if (play) this.finishPlay(play, { reason: play.stopRequested ? 'stopped' : 'finished' });
    });
  }

  async connect(): Promise<void> {
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch (err) {
      throw new VoiceJoinError('Could not connect to the voice channel in time', { cause: err });
    }
    if (this.destroyed) return;
    this.connection.subscribe(this.player);
  }

  play(stream: Readable, startTimeoutMs: number): PlayHandle {
    if (this.activePlay) this.finishPlay(this.activePlay, { reason: 'stopped' });
    const { play, handle } = createPlay(stream);
    this.activePlay = play;
    stream.on('error', (err: unknown) => {
      play.sourceError = err;
    });
    void this.startPlay(play, startTimeoutMs);
    return handle;
  }

  stop(): void {
    const play = this.activePlay;
    if (!play) return;
    play.stopRequested = true;
    try {
      this.player.stop(true);
    } catch {
      // ignore: player already stopped
    }
    this.finishPlay(play, { reason: 'stopped' }); // covers a player that never left Idle
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const play = this.activePlay;
    if (play) {
      play.stopRequested = true;
      this.finishPlay(play, { reason: 'stopped' });
    }
    try {
      this.player.stop(true);
    } catch {
      // ignore: player already stopped
    }
    try {
      this.connection.destroy();
    } catch {
      // ignore: connection already destroyed
    }
  }

  private async startPlay(play: ActivePlay, startTimeoutMs: number): Promise<void> {
    try {
      const probe = await demuxProbe(play.stream);
      this.log.debug({ streamType: probe.type }, 'audio stream probed');
      if (play.done) {
        probe.stream.destroy(); // stopped while probing
        return;
      }
      this.player.play(createAudioResource(probe.stream, { inputType: probe.type }));
      try {
        await entersState(this.player, AudioPlayerStatus.Playing, startTimeoutMs);
      } catch (err) {
        throw new MediaError('TIMEOUT', 'Audio did not start in time', { cause: err });
      }
      if (play.done) return;
      play.startedSettled = true;
      play.resolveStarted();
    } catch (err) {
      this.finishPlay(play, { reason: 'error', error: err });
    }
  }

  /** Settles one track's handle, exactly once. */
  private finishPlay(play: ActivePlay, end: TrackEnd): void {
    if (play.done) return;
    play.done = true;
    if (this.activePlay === play) this.activePlay = null;

    let final = end;
    if (end.reason === 'error' && play.sourceError instanceof MediaError) {
      final = { reason: 'error', error: play.sourceError }; // keep the yt-dlp error code
    }
    if (!play.startedSettled) {
      play.startedSettled = true;
      play.rejectStarted(
        final.reason === 'error' ? final.error : new Error('Playback ended before it started'),
      );
    }
    if (final.reason !== 'finished') {
      try {
        this.player.stop(true);
      } catch {
        // ignore: player already stopped
      }
    }
    play.stream.destroy();
    play.resolveEnded(final);
  }

  private async watchDisconnect(handlers: VoiceDriverHandlers): Promise<void> {
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, RECONNECT_WINDOW_MS),
        entersState(this.connection, VoiceConnectionStatus.Connecting, RECONNECT_WINDOW_MS),
      ]);
      // Reconnecting by itself (for example, the bot was moved): nothing to do.
    } catch {
      if (!this.destroyed) handlers.onDisconnected();
    }
  }
}

export function createDiscordVoiceDriverFactory(
  client: Client,
  logger: AppLogger,
): VoiceDriverFactory {
  return (target, handlers) => {
    const guild = client.guilds.cache.get(target.guildId);
    if (!guild) throw new VoiceJoinError('I could not find that server.');
    return new DiscordVoiceDriver(
      guild,
      target,
      handlers,
      logger.child({ guildId: target.guildId }),
    );
  };
}
