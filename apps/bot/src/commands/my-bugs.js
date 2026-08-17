const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, queryBugReports } = require('@bugtracker/db');
const { buildBugListPayload, parseExcludeStatuses, STATUS_LABELS } = require('../lib/bugListPayload');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-bugs')
    .setDescription('See the status of the bugs you have reported in this server')
    .addStringOption((opt) =>
      opt
        .setName('exclude')
        .setDescription("Statuses to leave out, comma-separated — e.g. \"Fixed, Won't fix\"")
        .setRequired(false)
        .setMaxLength(100),
    ),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const { excludeStatuses, invalid } = parseExcludeStatuses(interaction.options.getString('exclude'));
    if (invalid.length) {
      return interaction.reply({
        content: `Didn't recognize: ${invalid.join(', ')}. Valid statuses: ${Object.values(STATUS_LABELS).join(', ')}.`,
        ephemeral: true,
      });
    }

    // archived defaults to false in queryBugReports — only non-archived,
    // non-deleted reports show here, as requested.
    const queryResult = await queryBugReports(server.id, { reporterDiscordId: interaction.user.id, excludeStatuses, page: 1, pageSize: 5 });

    const excludeNote = excludeStatuses.length ? ` (excluding ${excludeStatuses.map((s) => STATUS_LABELS[s]).join(', ')})` : '';
    const payload = buildBugListPayload({
      title: 'Your bug reports' + excludeNote,
      queryResult,
      mode: 'mine',
      targetDiscordId: interaction.user.id,
      excludeStatuses,
      emptyMessage: "You haven't reported any bugs here yet.",
    });

    await interaction.reply({ ...payload, ephemeral: true });
  },
};
