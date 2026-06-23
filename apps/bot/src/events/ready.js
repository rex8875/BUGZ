const { registerGuild } = require('../lib/registerGuild');

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    console.log(`Logged in as ${client.user.tag}. Reconciling ${client.guilds.cache.size} guild(s)...`);
    for (const guild of client.guilds.cache.values()) {
      try {
        await registerGuild(guild);
      } catch (err) {
        console.error(`Failed to register guild ${guild.id} (${guild.name}):`, err);
      }
    }
    console.log('Guild reconciliation complete.');
  },
};
