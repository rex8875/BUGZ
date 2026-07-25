const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { getServerByDiscordId, updateServerSettings } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-announce-channel')
    .setDescription('Choose which channel new-report announcements post to')
    .addChannelOption((opt) =>
      opt.setName('channel').setDescription('Target channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
    ),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const channel = interaction.options.getChannel('channel');

    try {
      await updateServerSettings({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        announceChannelId: channel.id,
      });
      await interaction.reply({ content: `New-report announcements will now post in ${channel}.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
