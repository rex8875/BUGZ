const { getServerByDiscordId, removeMembershipOnLeave } = require('@bugtracker/db');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    const server = await getServerByDiscordId(member.guild.id);
    if (!server) return;
    await removeMembershipOnLeave(server.id, member.id);
  },
};
