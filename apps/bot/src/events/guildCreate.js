const { registerGuild } = require('../lib/registerGuild');

module.exports = {
  name: 'guildCreate',
  async execute(guild) {
    await registerGuild(guild);
  },
};
