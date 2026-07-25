const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, getMembership, queryBugReports } = require('@bugtracker/db');
const { buildBugListPayload } = require('../lib/bugListPayload');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bugs-by')
    .setDescription('See the bugs a specific person has reported in this server')
    .addUserOption((opt) => opt.setName('user').setDescription('The reporter to look up').setRequired(true)),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const membership = await getMembership(server.id, interaction.user.id);
    if (!membership) {
      return interaction.reply({ content: "You're not a member of this server's tester program.", ephemeral: true });
    }

    const target = interaction.options.getUser('user');
    const queryResult = await queryBugReports(server.id, { reporterDiscordId: target.id, page: 1, pageSize: 5 });

    const payload = buildBugListPayload({
      title: `Bugs reported by ${target.username}`,
      queryResult,
      mode: 'by',
      targetDiscordId: target.id,
      // Includes people who've since left the server — this never joins
      // through Membership, so their reports are still found here.
      emptyMessage: `${target.username} hasn't reported any bugs here (that are still visible).`,
    });

    await interaction.reply({ ...payload, ephemeral: true });
  },
};
