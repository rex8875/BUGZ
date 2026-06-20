const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { getServerByDiscordId, updateServerSettings } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-retest-channel')
    .setDescription('Choose which channel "Ping testers" / "Post in retested" send reports to')
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
        retestChannelId: channel.id,
      });
      await interaction.reply({ content: `Retest channel set to ${channel}.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
