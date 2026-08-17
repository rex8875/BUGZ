const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, getEffectivePermissions, queryBugReports } = require('@bugtracker/db');
const { buildBugListPayload, parseExcludeStatuses, STATUS_LABELS } = require('../lib/bugListPayload');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bugs-by')
    .setDescription('See the bugs a specific person has reported in this server')
    .addUserOption((opt) => opt.setName('user').setDescription('The reporter to look up').setRequired(true))
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

    const perms = await getEffectivePermissions(server.id, interaction.user.id);
    if (!perms?.canViewDashboard) {
      return interaction.reply({ content: "You don't have permission to view bug reports in this server.", ephemeral: true });
    }

    const { excludeStatuses, invalid } = parseExcludeStatuses(interaction.options.getString('exclude'));
    if (invalid.length) {
      return interaction.reply({
        content: `Didn't recognize: ${invalid.join(', ')}. Valid statuses: ${Object.values(STATUS_LABELS).join(', ')}.`,
        ephemeral: true,
      });
    }

    const target = interaction.options.getUser('user');
    const queryResult = await queryBugReports(server.id, { reporterDiscordId: target.id, excludeStatuses, page: 1, pageSize: 5 });

    const excludeNote = excludeStatuses.length ? ` (excluding ${excludeStatuses.map((s) => STATUS_LABELS[s]).join(', ')})` : '';
    const payload = buildBugListPayload({
      title: `Bugs reported by ${target.username}` + excludeNote,
      queryResult,
      mode: 'by',
      targetDiscordId: target.id,
      excludeStatuses,
      // Includes people who've since left the server — this never joins
      // through Membership, so their reports are still found here.
      emptyMessage: `${target.username} hasn't reported any bugs here (that are still visible).`,
    });

    await interaction.reply({ ...payload, ephemeral: true });
  },
};
