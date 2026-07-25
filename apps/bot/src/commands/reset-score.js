const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, resetLeaderboardScore } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reset-score')
    .setDescription("Reset someone's leaderboard score to zero")
    .addUserOption((opt) => opt.setName('user').setDescription('Whose score to reset').setRequired(true)),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const target = interaction.options.getUser('user');
    try {
      await resetLeaderboardScore({ serverId: server.id, actingDiscordId: interaction.user.id, targetDiscordId: target.id });
      await interaction.reply({ content: `Reset ${target.username}'s leaderboard score to 0.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
