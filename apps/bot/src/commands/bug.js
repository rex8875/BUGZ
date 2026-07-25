const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerByDiscordId, getMembership, getBugReportByNumber } = require('@bugtracker/db');
const { STATUS_LABELS } = require('../lib/bugListPayload');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bug')
    .setDescription('Look up a single bug report by its number')
    .addIntegerOption((opt) => opt.setName('number').setDescription('The bug number, e.g. 42').setRequired(true).setMinValue(1)),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const membership = await getMembership(server.id, interaction.user.id);
    if (!membership) {
      return interaction.reply({ content: "You're not a member of this server's tester program.", ephemeral: true });
    }

    const number = interaction.options.getInteger('number');
    const report = await getBugReportByNumber(server.id, number);
    if (!report) {
      return interaction.reply({ content: `No bug #${number} found in this server.`, ephemeral: true });
    }

    const link = `${process.env.WEB_BASE_URL}/r/${report.id}`;
    const embed = new EmbedBuilder()
      .setTitle(`#${report.bugNumber} — ${report.title}`)
      .setURL(link)
      .setColor(0x5865f2)
      .setDescription(report.description)
      .addFields(
        { name: 'Status', value: STATUS_LABELS[report.status] || report.status, inline: true },
        { name: 'Priority', value: report.priority, inline: true },
        { name: 'Device', value: report.device || 'Not specified', inline: true },
        { name: 'Reported by', value: report.reporter?.discordUsername || 'unknown', inline: true },
        { name: 'Reported on', value: new Date(report.createdAt).toLocaleDateString(), inline: true },
      );
    if (report.archivedAt) embed.setFooter({ text: 'This report is archived.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
