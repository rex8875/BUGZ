const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, promoteMember, listRoles } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-role')
    .setDescription("Add someone to this server's tester/dev program, or change their role")
    .addUserOption((opt) => opt.setName('user').setDescription('Who to set the role for').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('role').setDescription('Which role to give them').setRequired(true).setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.respond([]);

    const focused = interaction.options.getFocused().toLowerCase();
    const roles = await listRoles(server.id);
    const matches = roles
      .filter((r) => r.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((r) => ({ name: `${r.name} (rank ${r.rank})`, value: r.id }));

    await interaction.respond(matches);
  },

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const roleId = interaction.options.getString('role');

    try {
      await promoteMember({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        targetDiscordId: targetUser.id,
        newRoleId: roleId,
      });
      await interaction.reply({ content: `Done — ${targetUser.username} is set.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
