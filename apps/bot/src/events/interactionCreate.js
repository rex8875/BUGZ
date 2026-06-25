const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getUserByDiscordId, getServerByDiscordId, getMembership, createBugReport, permissionsFromRoles, rolesOf } = require('@bugtracker/db');
const { buildCoreModal, buildEvidenceModal } = require('../lib/bugReportModals');
const { saveDraft, getDraft, clearDraft } = require('../lib/bugReportDrafts');

function continueButtonRow() {
  const button = new ButtonBuilder().setCustomId('continue_bug_report_modal2').setLabel('Continue').setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(button)];
}

function retryButtonRow() {
  const button = new ButtonBuilder().setCustomId('retry_bug_report_modal2').setLabel('Try again').setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(button)];
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    // ---- Autocomplete (e.g. /set-role's role option) ----
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }

    // ---- Slash commands ----
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction);
      } catch (err) {
        console.error(err);
        await interaction.reply({ content: 'Something went wrong running that command.', ephemeral: true });
      }
      return;
    }

    // ---- Buttons ----
    if (interaction.isButton()) {
      if (interaction.customId === 'open_bug_report_modal1') {
        const user = await getUserByDiscordId(interaction.user.id);
        if (!user?.verifiedAt) {
          return interaction.reply({
            content: 'You need to verify your Discord identity first — run `/verify`.',
            ephemeral: true,
          });
        }

        const server = await getServerByDiscordId(interaction.guildId);
        const membership = server ? await getMembership(server.id, interaction.user.id) : null;
        const perms = membership ? permissionsFromRoles(rolesOf(membership)) : null;
        if (!perms?.canSubmitBugs) {
          return interaction.reply({
            content: "You don't have permission to report bugs in this server.",
            ephemeral: true,
          });
        }

        return interaction.showModal(buildCoreModal());
      }

      if (interaction.customId === 'continue_bug_report_modal2' || interaction.customId === 'retry_bug_report_modal2') {
        return interaction.showModal(buildEvidenceModal());
      }
      return;
    }

    // ---- Modal submissions ----
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'bugReportModal1') {
        saveDraft(interaction.user.id, {
          title: interaction.fields.getTextInputValue('title'),
          description: interaction.fields.getTextInputValue('description'),
          stepsToReproduce: interaction.fields.getTextInputValue('steps') || null,
          device: interaction.fields.getStringSelectValues('device')[0],
          priority: interaction.fields.getStringSelectValues('priority')[0],
        });

        return interaction.reply({
          content: 'Got the basics — now add your evidence and F9 capture.',
          components: continueButtonRow(),
          ephemeral: true,
        });
      }

      if (interaction.customId === 'bugReportModal2') {
        const draft = getDraft(interaction.user.id);
        if (!draft) {
          return interaction.reply({
            content: 'Your draft expired before you finished. Click "Report bug" again to start over.',
            ephemeral: true,
          });
        }

        const evidenceFiles = interaction.fields.getUploadedFiles('evidenceFile');
        const evidenceLink = interaction.fields.getTextInputValue('evidenceLink');
        const f9Files = interaction.fields.getUploadedFiles('f9File');
        const f9Link = interaction.fields.getTextInputValue('f9Link');
        const additionalInfo = interaction.fields.getTextInputValue('additionalInfo') || null;

        const hasEvidence = (evidenceFiles && evidenceFiles.length > 0) || evidenceLink;
        const hasF9 = (f9Files && f9Files.length > 0) || f9Link;

        if (!hasEvidence || !hasF9) {
          return interaction.reply({
            content: 'Evidence and F9 each need either an uploaded file or a link — at least one of the two, for both.',
            components: retryButtonRow(),
            ephemeral: true,
          });
        }

        const server = await getServerByDiscordId(interaction.guildId);

        try {
          await createBugReport(server.id, interaction.user.id, {
            ...draft,
            evidenceFileUrl: evidenceFiles?.[0]?.url ?? null,
            evidenceLink: evidenceLink || null,
            f9FileUrl: f9Files?.[0]?.url ?? null,
            f9Link: f9Link || null,
            additionalInfo,
          });
        } catch (err) {
          return interaction.reply({ content: err.message, ephemeral: true });
        }

        clearDraft(interaction.user.id);

        return interaction.reply({ content: 'Bug report submitted — thanks!', ephemeral: true });
      }
    }
  },
};
