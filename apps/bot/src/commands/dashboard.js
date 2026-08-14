const { SlashCommandBuilder } = require('discord.js');
const { getServerByDiscordId } = require('@bugtracker/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Get a link to this server\'s bug dashboard'),

  async execute(interaction) {
    const server = await getServerByDiscordId(interaction.guildId);
    if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

    const url = `${process.env.WEB_BASE_URL}/dashboard/${server.id}`;
    await interaction.reply({
      content: `Here's your dashboard link: ${url}\nYou'll need to verify with Discord the first time you open it.`,
      ephemeral: true,
    });
  },
};
