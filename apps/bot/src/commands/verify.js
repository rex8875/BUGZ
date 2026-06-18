const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your Discord identity so you can report bugs or use the dashboard'),

  async execute(interaction) {
    const button = new ButtonBuilder()
      .setLabel('Verify with Discord')
      .setStyle(ButtonStyle.Link)
      .setURL(`${process.env.WEB_BASE_URL}/auth/discord`);

    await interaction.reply({
      content: 'Click below to confirm your Discord identity. This only needs to be done once, ever — not per server.',
      components: [new ActionRowBuilder().addComponents(button)],
      ephemeral: true,
    });
  },
};
