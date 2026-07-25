const { getServerByDiscordId, restoreLeaderboardVisibilityOnRejoin } = require('@bugtracker/db');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    const server = await getServerByDiscordId(member.guild.id);
    if (!server) return;
    // Automatic — no admin action needed. Their bot role/Membership
    // still requires being re-granted separately (unchanged), but their
    // leaderboard score (if they had one hidden from leaving) becomes
    // visible again right away.
    await restoreLeaderboardVisibilityOnRejoin(server.id, member.id);
  },
};
