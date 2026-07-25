const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// Reads every command's name/description straight from its own
// SlashCommandBuilder — the same directory this file lives in, scanned
// the same way deploy-commands.js registers them — so /help can never
// silently drift out of sync with what's actually available.
function listCommands() {
  return fs
    .readdirSync(__dirname)
    .filter((file) => file !== 'help.js' && file.endsWith('.js'))
    .map((file) => require(path.join(__dirname, file)).data.toJSON())
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('List all available commands'),

  async execute(interaction) {
    const commands = listCommands();
    const embed = new EmbedBuilder()
      .setTitle('Available commands')
      .setColor(0x5865f2)
      .setDescription(commands.map((c) => `**/${c.name}** — ${c.description}`).join('\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
