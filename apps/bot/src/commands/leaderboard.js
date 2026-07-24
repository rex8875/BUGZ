const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getServerByDiscordId, getLeaderboard, getWeeklyLeaderboard } = require('@bugtracker/db');

// Shared by both the initial /leaderboard reply and the button handler in
// interactionCreate.js, so "switch scope" / "refresh" never re-run the
// slash command — they just rebuild this same payload with fresh data.
async function buildLeaderboardPayload(serverId, scope) {
  let scores, title;

  if (scope === 'weekly') {
    const result = await getWeeklyLeaderboard(serverId);
    scores = result.scores;
    title = `This week's bug-hunting leaderboard`;
  } else {
    scores = await getLeaderboard(serverId);
    title = 'All-time bug-hunting leaderboard';
  }

  const medals = ['🥇', '🥈', '🥉'];
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xf0b232)
    .setFooter({ text: `Last updated ${new Date().toLocaleTimeString()}` })
    .setDescription(
      scores.length === 0
        ? 'No points on the board yet — be the first to report a bug.'
        : scores
            .slice(0, 10)
            .map((s, i) => `${medals[i] || `${i + 1}.`} **${s.user.discordUsername}** — ${s.points} point${s.points === 1 ? '' : 's'}`)
            .join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`leaderboard_scope_all-time`)
      .setLabel('All-time')
      .setStyle(scope === 'all-time' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(scope === 'all-time'),
    new ButtonBuilder()
      .setCustomId(`leaderboard_scope_weekly`)
      .setLabel('This week')
      .setStyle(scope === 'weekly' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(scope === 'weekly'),
    new ButtonBuilder().setCustomId(`leaderboard_refresh_${scope}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

module.exports = {
  buildLeaderboardPayload,
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('See who has found the most bugs in this server')
    .addStringOption((opt) =>
      opt
        .setName('scope')
        .setDescription('All-time or this week')
        .setRequired(false)
        .addChoices({ name: 'All-time', value: 'all-time' }, { name: 'This week', value: 'weekly' }),
    ),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const scope = interaction.options.getString('scope') || 'all-time';
    const payload = await buildLeaderboardPayload(server.id, scope);
    await interaction.reply(payload);
  },
};
