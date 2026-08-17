const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, getEffectivePermissions, queryBugReports } = require('@bugtracker/db');
const { buildBugListPayload, parseExcludeStatuses, STATUS_LABELS } = require('../lib/bugListPayload');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-bugs')
    .setDescription('Check existing bug reports before submitting a new one, to avoid duplicates')
    .addStringOption((opt) =>
      opt.setName('search').setDescription('Filter by keyword in the title or description').setRequired(false).setMaxLength(50),
    )
    .addStringOption((opt) =>
      opt
        .setName('priority')
        .setDescription('Filter by priority tag')
        .setRequired(false)
        .addChoices(
          { name: 'Low', value: 'LOW' },
          { name: 'Medium', value: 'MEDIUM' },
          { name: 'High', value: 'HIGH' },
          { name: 'Critical', value: 'CRITICAL' },
        ),
    )
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

    const search = interaction.options.getString('search');
    const priority = interaction.options.getString('priority');
    const queryResult = await queryBugReports(server.id, { search, priority, excludeStatuses, page: 1, pageSize: 5 });

    const excludeNote = excludeStatuses.length ? ` (excluding ${excludeStatuses.map((s) => STATUS_LABELS[s]).join(', ')})` : '';
    const payload = buildBugListPayload({
      title: (search ? `Reports matching "${search}"` : 'Open reports') + excludeNote,
      queryResult,
      mode: 'all',
      priority,
      search,
      excludeStatuses,
      emptyMessage: search ? `No reports match "${search}". Looks like a new one!` : 'No reports match those filters.',
    });

    await interaction.reply({ ...payload, ephemeral: true });
  },
};
