const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerByDiscordId, listMyBugReports } = require('@bugtracker/db');

const STATUS_LABELS = {
  NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug',
  DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix",
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-bugs')
    .setDescription('See the status of the bugs you have reported in this server'),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const reports = await listMyBugReports(server.id, interaction.user.id);
    if (reports.length === 0) {
      return interaction.reply({ content: "You haven't reported any bugs here yet.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('Your bug reports')
      .setColor(0x5865f2)
      .setDescription(
        reports
          .slice(0, 10)
          .map((r) => `**${r.title}** — ${STATUS_LABELS[r.status] || r.status}${r.archivedAt ? ' (archived)' : ''}`)
          .join('\n'),
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
