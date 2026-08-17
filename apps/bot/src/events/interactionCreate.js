const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { getUserByDiscordId, getServerByDiscordId, getEffectivePermissions, createBugReport, countBugReportsByReporter, queryBugReports, getBugReportPublic } = require('@bugtracker/db');
const { postNewReportAnnouncement } = require('../lib/announcements');
const { buildBugListPayload, decodeBugListCustomId, STATUS_LABELS } = require('../lib/bugListPayload');
const { checkCommandAccess } = require('../lib/commandAccess');
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

      const access = await checkCommandAccess(interaction, interaction.commandName);
      if (!access.allowed) {
        return interaction.reply({ content: "You don't have permission to use this command in this server.", ephemeral: true });
      }

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
      if (interaction.customId.startsWith('buglist:')) {
        const { mode, page, priority, search, targetDiscordId, excludeStatuses } = decodeBugListCustomId(interaction.customId);
        const server = await getServerByDiscordId(interaction.guildId);
        if (!server) return interaction.update({ content: 'This server is not set up yet.', embeds: [], components: [] });

        // Re-check permission on every page click, not just when the
        // command was first run — a stale button in an old ephemeral
        // message shouldn't outlive someone's access, and their access
        // is checked live against Discord anyway.
        const perms = await getEffectivePermissions(server.id, interaction.user.id);
        if (!perms?.canViewDashboard) {
          return interaction.update({ content: "You don't have permission to view bug reports in this server.", embeds: [], components: [] });
        }

        let queryResult, title, emptyMessage;
        if (mode === 'mine') {
          // Always the clicking user's own reports, regardless of what's
          // encoded in the customId — never someone else's, even if the
          // id were somehow tampered with.
          queryResult = await queryBugReports(server.id, { reporterDiscordId: interaction.user.id, excludeStatuses, page, pageSize: 5 });
          title = 'Your bug reports';
          emptyMessage = "You haven't reported any bugs here yet.";
        } else if (mode === 'by') {
          queryResult = await queryBugReports(server.id, { reporterDiscordId: targetDiscordId, excludeStatuses, page, pageSize: 5 });
          title = `Bugs reported by <@${targetDiscordId}>`;
          emptyMessage = "That person hasn't reported any bugs here (that are still visible).";
        } else {
          queryResult = await queryBugReports(server.id, { priority, search, excludeStatuses, page, pageSize: 5 });
          title = search ? `Reports matching "${search}"` : 'Open reports';
          emptyMessage = search ? `No reports match "${search}".` : 'No reports match those filters.';
        }

        const payload = buildBugListPayload({ title, queryResult, mode, priority, search, targetDiscordId, excludeStatuses, emptyMessage });
        return interaction.update(payload);
      }

      if (interaction.customId.startsWith('view:')) {
        const reportId = interaction.customId.slice('view:'.length);
        const server = await getServerByDiscordId(interaction.guildId);
        if (!server) return interaction.reply({ content: 'This server is not set up yet.', ephemeral: true });

        // Re-checked live, same as every other permission-gated action —
        // a button in an old message shouldn't outlive someone's access.
        const perms = await getEffectivePermissions(server.id, interaction.user.id);
        if (!perms?.canViewDashboard) {
          return interaction.reply({ content: "You don't have permission to view bug reports in this server.", ephemeral: true });
        }

        // getBugReportPublic is the exact same safe, evidence/F9-free
        // shape the public /r/:id webpage uses — reused here rather
        // than duplicated, so the two "read-only view" surfaces can
        // never drift out of sync on what's safe to show.
        const report = await getBugReportPublic(reportId);
        if (!report || report.serverId !== server.id) {
          return interaction.reply({ content: 'That report no longer exists.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle(`#${report.bugNumber} — ${report.title}`)
          .setColor(0x5865f2)
          .setDescription(report.description)
          .addFields(
            { name: 'Priority', value: report.priority, inline: true },
            { name: 'Status', value: STATUS_LABELS[report.status] || report.status, inline: true },
            { name: 'Device', value: report.device || 'unspecified', inline: true },
            { name: 'Reported by', value: report.reporterUsername, inline: true },
            { name: 'Date', value: new Date(report.createdAt).toLocaleDateString(), inline: true },
          );
        if (report.stepsToReproduce) embed.addFields({ name: 'Steps to reproduce', value: report.stepsToReproduce });

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

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
        const perms = server ? await getEffectivePermissions(server.id, interaction.user.id) : null;
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
          // from under it. Update the very message the Continue button
          // lives on directly, in one step, rather than leaving it
          // untouched and sending a second, separate message — a second
          // click on a since-emptied button is not how anyone should
          // have to discover their draft expired.
          return interaction.update({
            content: 'Your draft expired before you finished. Click "Report bug" again to start over.',
            embeds: [],
            components: [],
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
          // Leave the draft alive on failure (e.g. validation error) so
          // the person can retry without re-typing modal 1 — update the
          // same message in place with the error and a fresh Continue
          // button, rather than leaving a stale button sitting under a
          // separate, easy-to-miss error reply.
          return interaction.update({ content: `${err.message} Click Continue to try again.`, embeds: [], components: continueButtonRow() });
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

        // Update the exact message the Continue button was on, in one
        // atomic step, as this interaction's own primary response —
        // rather than a best-effort separate edit plus a second new
        // reply. The button disappears and the same message becomes
        // the confirmation; nothing stale is left behind, and there's
        // no second message to notice or reclick anything on.
        return interaction.update({ content: 'Bug report submitted — thanks!', embeds: [], components: [] });
      }
    }
  },
};
