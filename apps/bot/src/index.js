require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

for (const file of fs.readdirSync(path.join(__dirname, 'commands'))) {
  const command = require(path.join(__dirname, 'commands', file));
  client.commands.set(command.data.name, command);
}

for (const file of fs.readdirSync(path.join(__dirname, 'events'))) {
  const event = require(path.join(__dirname, 'events', file));
  client.on(event.name, (...args) => event.execute(...args));
}

client.login(process.env.DISCORD_BOT_TOKEN);
