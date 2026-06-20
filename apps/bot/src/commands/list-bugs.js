const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerByDiscordId, getMembership, searchBugReports } = require('@bugtracker/db');

const STATUS_LABELS = {
  NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug',
  DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix",
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-bugs')
    .setDescription('Check existing bug reports before submitting a new one, to avoid duplicates')
    .addStringOption((opt) =>
      opt.setName('search').setDescription('Filter by keyword in the title').setRequired(false),
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
    ),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const membership = await getMembership(server.id, interaction.user.id);
    if (!membership) {
      return interaction.reply({ content: "You're not a member of this server's tester program.", ephemeral: true });
    }

    const search = interaction.options.getString('search');
    const priority = interaction.options.getString('priority');
    const reports = await searchBugReports(server.id, { search, priority });

    if (reports.length === 0) {
      return interaction.reply({
        content: search ? `No open reports match "${search}". Looks like a new one!` : 'No open reports match those filters.',
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(search ? `Open reports matching "${search}"` : 'Open reports')
      .setColor(0x5865f2)
      .setDescription(
        reports.map((r) => `**${r.title}** — ${r.priority} · ${STATUS_LABELS[r.status] || r.status}`).join('\n'),
      )
      .setFooter({ text: "If yours is already here, don't submit a duplicate — it'll cost the point." });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
