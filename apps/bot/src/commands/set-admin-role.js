const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId, setRolePermissions } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-admin-role')
    .setDescription('Give an existing Discord role full access to every command and permission')
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('The Discord role to grant full access to (e.g. your existing @Tester role)').setRequired(true),
    ),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const role = interaction.options.getRole('role');

    try {
      // Just a convenience shortcut over the general role-permission
      // system — sets every flag true for this one role, through the
      // exact same mechanism /set-admin-role always used before the
      // permission system was unified around real Discord roles. Not a
      // separate bypass path anymore.
      await setRolePermissions({
        serverId: server.id,
        actingDiscordId: interaction.user.id,
        discordRoleId: role.id,
        permissions: {
          canSubmitBugs: true,
          canViewDashboard: true,
          canManageBugs: true,
          canPingTesters: true,
          canArchive: true,
          canEditReports: true,
          canDeleteReports: true,
          canShareDashboard: true,
          canBanMembers: true,
          canManageRoles: true,
          canManageSettings: true,
        },
      });
      await interaction.reply({
        content: `Done — anyone with the ${role} role now has full access to every command and permission, checked live against Discord. This isn't a separate bot role; it's tied directly to that Discord role, so removing the role there removes access immediately.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
