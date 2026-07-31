const { getServerByDiscordId, hideLeaverFromLeaderboard } = require('@bugtracker/db');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    const server = await getServerByDiscordId(member.guild.id);
    if (!server) return;
    // No internal role/membership to clean up anymore — permissions are
    // checked live against Discord, so this person's access is already
    // gone the moment Discord no longer lists them as a member. The one
    // thing that DOES need explicit handling is the leaderboard.
    await hideLeaverFromLeaderboard(server.id, member.id);
  },
};
