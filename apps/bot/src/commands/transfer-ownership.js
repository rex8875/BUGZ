const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, transferOwnership } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('transfer-ownership')
    .setDescription("Transfer ownership of this server's bug tracker to someone else")
    .addUserOption((opt) => opt.setName('user').setDescription('New owner').setRequired(true)),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const targetUser = interaction.options.getUser('user');

    try {
      await transferOwnership({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        newOwnerDiscordId: targetUser.id,
      });
      await interaction.reply({ content: `Ownership transferred to ${targetUser.username}.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
