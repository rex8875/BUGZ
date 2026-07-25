const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, queryBugReports } = require('@bugtracker/db');
const { buildBugListPayload } = require('../lib/bugListPayload');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-bugs')
    .setDescription('See the status of the bugs you have reported in this server'),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    // archived defaults to false in queryBugReports — only non-archived,
    // non-deleted reports show here, as requested.
    const queryResult = await queryBugReports(server.id, { reporterDiscordId: interaction.user.id, page: 1, pageSize: 5 });

    const payload = buildBugListPayload({
      title: 'Your bug reports',
      queryResult,
      mode: 'mine',
      targetDiscordId: interaction.user.id,
      emptyMessage: "You haven't reported any bugs here yet.",
    });

    await interaction.reply({ ...payload, ephemeral: true });
  },
};
