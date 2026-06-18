const { AuditLogEvent } = require('discord.js');
const { createServerOnJoin } = require('@bugtracker/db');

module.exports = {
  name: 'guildCreate',
  async execute(guild) {
    // Default to the guild's Discord-owner. This always works with no
    // extra permissions.
    let ownerDiscordId = guild.ownerId;

    // Try to do better: if we can read the audit log, find out who
    // actually clicked "Authorize" for this bot.
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
      const entry = logs.entries.find((e) => e.target?.id === guild.client.user.id);
      if (entry?.executor) ownerDiscordId = entry.executor.id;
    } catch {
      // Missing "View Audit Log" permission, or the bot fetched this
      // too late for the entry to still be there — the guild-owner
      // fallback above already covers us.
    }

    await createServerOnJoin({
      discordServerId: guild.id,
      name: guild.name,
      ownerDiscordId,
    });
  },
};
