import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { VoiceJoinError } from '../../core/errors.js';
import type { EnqueueOutcome } from '../../core/SessionManager.js';
import { MediaError, userMessage } from '../../media/errors.js';
import type { TrackMeta } from '../../media/MediaProvider.js';
import { parseYoutubeUrl } from '../../media/urlParser.js';
import type { ParseFailure } from '../../media/urlParser.js';
import { formatDuration } from '../../utils/time.js';
import type { Command } from './types.js';

const PARSE_MESSAGES: Record<ParseFailure, string> = {
  invalid_url: 'That does not look like a valid YouTube link.',
  unsupported_host: 'Only YouTube links are supported.',
  no_video: 'I could not find a video in that link.',
  unsupported_playlist:
    'That playlist type is not supported (mixes, Liked videos and Watch later cannot be used).',
};

const ephemeral = (interaction: ChatInputCommandInteraction, content: string) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral });

/** After a public deferReply, swap the "thinking" message for a private error. */
async function failDeferred(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  try {
    await interaction.deleteReply();
  } catch {
    // ignore: nothing to delete
  }
  await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
}

const wrongChannelMessage = (channelId: string): string =>
  `I am already in <#${channelId}>. Join that channel to add tracks.`;

const queueFullMessage = (max: number): string => `Queue is full (${max}/${max}).`;

function enqueueFailureMessage(outcome: Extract<EnqueueOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case 'full':
      return queueFullMessage(outcome.max);
    case 'wrong_channel':
      return wrongChannelMessage(outcome.channelId);
    case 'join_failed':
      return outcome.error instanceof VoiceJoinError
        ? outcome.error.message
        : userMessage('INTERNAL');
    case 'session_gone':
      return 'The voice session ended while I was adding your track. Please try again.';
  }
}

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play the audio of a YouTube video in your voice channel')
    .addStringOption((o) =>
      o.setName('url').setDescription('YouTube video link').setRequired(true).setMaxLength(2048),
    ),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (!guild) {
      await ephemeral(interaction, 'This command only works inside a server.');
      return;
    }

    const parsed = parseYoutubeUrl(interaction.options.getString('url', true));
    if (!parsed.ok) {
      await ephemeral(interaction, PARSE_MESSAGES[parsed.reason]);
      return;
    }
    if (parsed.link.kind === 'playlist') {
      await ephemeral(
        interaction,
        'Playlist links are not supported in this build yet. Send a single video link for now.',
      );
      return;
    }
    const { videoId } = parsed.link;

    const channel = guild.voiceStates.cache.get(interaction.user.id)?.channel;
    if (!channel) {
      await ephemeral(interaction, 'Join a voice channel first, then run /play again.');
      return;
    }

    // Cheap early checks, so a doomed request does not wait for a metadata lookup. The session
    // re-checks both under its lock, so these are a courtesy, not the guarantee.
    const existing = ctx.sessions.get(guild.id);
    if (existing) {
      if (existing.voiceChannelId !== channel.id) {
        await ephemeral(interaction, wrongChannelMessage(existing.voiceChannelId));
        return;
      }
      if (existing.isFull) {
        await ephemeral(interaction, queueFullMessage(existing.maxQueueSize));
        return;
      }
    } else {
      // Only needed to join. If the bot is already in the channel these checks do not apply
      // (a full channel reports as not joinable even to a bot that is inside it).
      if (!channel.joinable) {
        await ephemeral(
          interaction,
          'I cannot join that voice channel. Check my View Channel and Connect permissions and the user limit.',
        );
        return;
      }
      const botMember = guild.members.me;
      if (!botMember || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.Speak)) {
        await ephemeral(interaction, 'I am not allowed to speak in that voice channel.');
        return;
      }
    }

    await interaction.deferReply();

    let track: TrackMeta;
    try {
      track = await ctx.media.resolve(videoId);
    } catch (err) {
      ctx.logger.warn({ err, guildId: guild.id, videoId }, 'resolve failed');
      await failDeferred(
        interaction,
        err instanceof MediaError ? userMessage(err.code) : userMessage('INTERNAL'),
      );
      return;
    }
    if (track.isLive) {
      await failDeferred(interaction, userMessage('LIVE_UNSUPPORTED'));
      return;
    }
    if (track.durationSec > ctx.config.maxTrackDurationSec) {
      await failDeferred(
        interaction,
        `${userMessage('TOO_LONG')} The limit is ${formatDuration(ctx.config.maxTrackDurationSec)}.`,
      );
      return;
    }

    const outcome = await ctx.sessions.enqueue({
      guildId: guild.id,
      voiceChannelId: channel.id,
      textChannelId: interaction.channelId,
      meta: track,
      requestedBy: {
        id: interaction.user.id,
        displayName:
          guild.members.cache.get(interaction.user.id)?.displayName ?? interaction.user.displayName,
      },
    });
    if (!outcome.ok) {
      ctx.logger.warn({ guildId: guild.id, videoId, reason: outcome.reason }, 'enqueue refused');
      await failDeferred(interaction, enqueueFailureMessage(outcome));
      return;
    }

    const duration = formatDuration(track.durationSec);
    const content = outcome.startsNow
      ? `Now playing: ${track.title} (${duration})`
      : `Added to queue at position ${outcome.position}: ${track.title} (${duration})`;
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  },
};
