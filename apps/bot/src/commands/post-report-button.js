const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getServerByDiscordId, getMembership } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('post-report-button')
    .setDescription('Post the "Report bug" button in this channel'),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) {
      return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });
    }

    const membership = await getMembership(server.id, interaction.user.id);
    if (!membership?.role.canManageSettings) {
      return interaction.reply({ content: "You don't have permission to do this.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('Report a bug')
      .setDescription('Click below to open the bug report form. Have your evidence ready.')
      .setColor(0x3ba55d);

    const button = new ButtonBuilder()
      .setCustomId('open_bug_report_modal1')
      .setLabel('Report bug')
      .setStyle(ButtonStyle.Secondary);

    await interaction.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
    await interaction.reply({ content: 'Posted.', ephemeral: true });
  },
};
