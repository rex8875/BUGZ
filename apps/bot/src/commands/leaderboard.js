const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerByDiscordId, getLeaderboard, getWeeklyLeaderboard } = require('@bugtracker/db');

module.exports = {
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
    let scores, title;

    if (scope === 'weekly') {
      const result = await getWeeklyLeaderboard(server.id);
      scores = result.scores;
      title = `This week's bug-hunting leaderboard`;
    } else {
      scores = await getLeaderboard(server.id);
      title = 'All-time bug-hunting leaderboard';
    }

    if (scores.length === 0) {
      return interaction.reply({ content: 'No points on the board yet — be the first to report a bug.', ephemeral: true });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xf0b232)
      .setDescription(
        scores
          .slice(0, 10)
          .map((s, i) => `${medals[i] || `${i + 1}.`} **${s.user.discordUsername}** — ${s.points} point${s.points === 1 ? '' : 's'}`)
          .join('\n'),
      );

    await interaction.reply({ embeds: [embed] });
  },
};
