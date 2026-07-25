const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getUserByDiscordId, getServerByDiscordId, getMembership, createBugReport, countBugReportsByReporter, permissionsFromRoles, rolesOf } = require('@bugtracker/db');
const { postNewReportAnnouncement } = require('../lib/announcements');
const { buildCoreModal, buildEvidenceModal } = require('../lib/bugReportModals');
const { saveDraft, getDraft, clearDraft } = require('../lib/bugReportDrafts');

function continueButtonRow() {
  const button = new ButtonBuilder().setCustomId('continue_bug_report_modal2').setLabel('Continue').setStyle(ButtonStyle.Primary);
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
      if (interaction.customId.startsWith('leaderboard_scope_') || interaction.customId.startsWith('leaderboard_refresh_')) {
        const { buildLeaderboardPayload } = require('../commands/leaderboard');
        const scope = interaction.customId.startsWith('leaderboard_scope_')
          ? interaction.customId.replace('leaderboard_scope_', '')
          : interaction.customId.replace('leaderboard_refresh_', '');
        const server = await getServerByDiscordId(interaction.guildId);
        if (!server) return interaction.update({ content: 'This server is not set up yet.', embeds: [], components: [] });
        const payload = await buildLeaderboardPayload(server.id, scope);
        return interaction.update(payload);
      }

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
        // Guard against a stale click: if the draft is gone (already
        // submitted, or expired), don't reopen the form — disable the
        // button in place and tell the person plainly instead.
        const draft = getDraft(interaction.user.id);
        if (!draft) {
          await interaction.update({
            content: 'This report was already submitted (or the draft expired). Run "Report bug" again to start a new one.',
            components: [],
          });
          return;
        }
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
          // The modal was already open when the draft expired/cleared out
          // from under it. Disable the originating button too, so a second
          // stale click can't get back in here.
          if (interaction.message) {
            await interaction.message.edit({ components: [] }).catch(() => {});
          }
          return interaction.reply({
            content: 'Your draft expired before you finished. Click "Report bug" again to start over.',
            ephemeral: true,
          });
        }

        const evidenceLink = interaction.fields.getTextInputValue('evidenceLink');
        const f9Link = interaction.fields.getTextInputValue('f9Link');
        const additionalInfo = interaction.fields.getTextInputValue('additionalInfo') || null;

        const server = await getServerByDiscordId(interaction.guildId);

        let report;
        try {
          report = await createBugReport(server.id, interaction.user.id, {
            ...draft,
            evidenceLink,
            f9Link,
            additionalInfo,
          });
        } catch (err) {
          // Leave the draft and the Continue button alive on failure
          // (e.g. validation error) so the person can retry without
          // re-typing modal 1.
          return interaction.reply({ content: err.message, ephemeral: true });
        }

        clearDraft(interaction.user.id);

        // Best-effort: a missing/deleted announce channel, or the bot
        // lacking send permission there, must never block confirming the
        // submission to the reporter — it's a nice-to-have, not part of
        // the report actually being saved.
        if (server.announceChannelId) {
          countBugReportsByReporter(server.id, interaction.user.id)
            .then((reportCountForUser) =>
              postNewReportAnnouncement({
                client: interaction.client,
                channelId: server.announceChannelId,
                report,
                reporterDiscordId: interaction.user.id,
                reportCountForUser,
              }),
            )
            .catch(() => {});
        }

        // The report is in — disable the Continue button on the modal-1
        // reply message so a stale click can never reopen this form again.
        if (interaction.message) {
          await interaction.message.edit({ content: 'Bug report submitted — thanks!', components: [] }).catch(() => {});
        }

        return interaction.reply({ content: 'Bug report submitted — thanks!', ephemeral: true });
      }
    }
  },
};
