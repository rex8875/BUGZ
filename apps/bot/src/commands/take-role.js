const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, getMembership, revokeRole, listRoles, permissionsFromRoles, rolesOf } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('take-role')
    .setDescription("Take a role away from someone, without affecting any other role they hold")
    .addUserOption((opt) => opt.setName('user').setDescription('Who to take the role from').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('role').setDescription('Which role to take away').setRequired(true).setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.respond([]);

    const acting = await getMembership(server.id, interaction.user.id);
    const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
    if (!actingPerms?.canManageRoles) return interaction.respond([]);

    const actingRank = Math.max(0, ...rolesOf(acting).map((r) => r.rank));
    const focused = interaction.options.getFocused().toLowerCase();
    const roles = await listRoles(server.id);
    const matches = roles
      .filter((r) => r.rank < actingRank)
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
      await revokeRole({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        targetDiscordId: targetUser.id,
        roleId,
      });
      await interaction.reply({ content: `Done — removed that role from ${targetUser.username}.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
