require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { deleteExpiredArchivedReports } = require('@bugtracker/db');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

for (const file of fs.readdirSync(path.join(__dirname, 'commands'))) {
  const command = require(path.join(__dirname, 'commands', file));
  client.commands.set(command.data.name, command);
}

for (const file of fs.readdirSync(path.join(__dirname, 'events'))) {
  const event = require(path.join(__dirname, 'events', file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

const ARCHIVE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a 15-day window
async function runArchiveCleanup() {
  try {
    const deleted = await deleteExpiredArchivedReports();
    if (deleted > 0) console.log(`Archive cleanup: deleted ${deleted} report(s) past the 15-day window.`);
  } catch (err) {
    console.error('Archive cleanup failed:', err);
  }
}
setInterval(runArchiveCleanup, ARCHIVE_CLEANUP_INTERVAL_MS);
runArchiveCleanup();

client.login(process.env.DISCORD_BOT_TOKEN);
