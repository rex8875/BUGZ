const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, getMembership, grantRole, listRoles, permissionsFromRoles, rolesOf } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('give-role')
    .setDescription("Give someone a role, without affecting any other role they already hold")
    .addUserOption((opt) => opt.setName('user').setDescription('Who to give the role to').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('role').setDescription('Which role to give').setRequired(true).setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.respond([]);

    // Don't leak the role list to people who couldn't use it anyway.
    const acting = await getMembership(server.id, interaction.user.id);
    const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
    if (!actingPerms?.canManageRoles) return interaction.respond([]);

    const actingRank = Math.max(0, ...rolesOf(acting).map((r) => r.rank));
    const focused = interaction.options.getFocused().toLowerCase();
    const roles = await listRoles(server.id);
    const matches = roles
      // Only show roles they could actually grant — same rank ceiling
      // grantRole enforces, so the list itself doesn't invite a failed attempt.
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
      await grantRole({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        targetDiscordId: targetUser.id,
        roleId,
      });
      await interaction.reply({ content: `Done — gave ${targetUser.username} that role.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
