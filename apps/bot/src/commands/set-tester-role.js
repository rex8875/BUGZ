const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, updateServerSettings } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-tester-role')
    .setDescription('Choose which role gets pinged when a dev clicks "Ping testers"')
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to ping').setRequired(true)),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const role = interaction.options.getRole('role');

    try {
      await updateServerSettings({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        testerPingRoleId: role.id,
      });
      await interaction.reply({ content: `"Ping testers" will now ping ${role}.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
