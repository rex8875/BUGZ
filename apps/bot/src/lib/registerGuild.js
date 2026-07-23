const { AuditLogEvent } = require('discord.js');
const { createServerOnJoin } = require('@bugtracker/db');

// Registers a guild the bot is in. Safe to call repeatedly (createServerOnJoin
// upserts) — used both when the bot newly joins a guild, and as a startup
// reconciliation pass for guilds the bot was already sitting in before it
// ever successfully ran (e.g. invited via the URL before `bot:dev` was set
// up), which never fire a guildCreate event since nothing "new" happened
// from Discord's perspective.
async function registerGuild(guild) {
  let ownerDiscordId = guild.ownerId;

  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
    const entry = logs.entries.find((e) => e.target?.id === guild.client.user.id);
    if (entry?.executor) ownerDiscordId = entry.executor.id;
  } catch {
    // Missing "View Audit Log" permission, or fetched too late — the
    // guild-owner fallback above already covers us.
  }

  await createServerOnJoin({
    discordServerId: guild.id,
    name: guild.name,
    ownerDiscordId,
    iconUrl: guild.iconURL ? guild.iconURL({ size: 128 }) : null,
  });
}

module.exports = { registerGuild };
