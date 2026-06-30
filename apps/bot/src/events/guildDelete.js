const { deactivateServer } = require('@bugtracker/db');

module.exports = {
  name: 'guildDelete',
  async execute(guild) {
    await deactivateServer(guild.id);
  },
};
