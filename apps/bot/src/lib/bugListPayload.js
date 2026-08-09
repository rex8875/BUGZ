const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const STATUS_LABELS = {
  NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug',
  DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix",
};

function reportLine(r) {
  const archivedTag = r.archivedAt ? ' *(archived)*' : '';
  const date = new Date(r.createdAt).toLocaleDateString();
  return `**#${r.bugNumber} — ${r.title}**${archivedTag}\n${r.priority} · ${STATUS_LABELS[r.status] || r.status} · reported ${date}`;
}

// mode/priority/search/targetDiscordId are round-tripped through the
// Prev/Next button customIds so a page click can re-run the exact same
// query — kept short since Discord customIds cap at 100 characters.
function buildBugListPayload({ title, queryResult, mode, priority, search, targetDiscordId, emptyMessage }) {
  const { reports, page, totalPages, totalCount } = queryResult;

  if (totalCount === 0) {
    return { content: emptyMessage, embeds: [], components: [] };
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865f2)
    .setDescription(reports.map(reportLine).join('\n\n'))
    .setFooter({ text: `Page ${page} of ${totalPages} · ${totalCount} report${totalCount === 1 ? '' : 's'} · tap a # below to view one` });

  const encode = (p) => ['buglist', mode, p, priority || '-', encodeURIComponent((search || '-').slice(0, 40)), targetDiscordId || '-'].join(':');

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(encode(page - 1)).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(encode(page + 1)).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
  );

  // Read-only detail view, without ever leaving Discord: one small
  // button per report on the page (pageSize is 5, so this always fits
  // within Discord's 5-buttons-per-row limit). Clicking replies
  // ephemerally with the same safe, evidence/F9-free view the public
  // /r/:id webpage shows — see getBugReportPublic.
  const viewRow = new ActionRowBuilder().addComponents(
    ...reports.map((r) => new ButtonBuilder().setCustomId(`view:${r.id}`).setLabel(`#${r.bugNumber}`).setStyle(ButtonStyle.Secondary)),
  );

  return { embeds: [embed], components: [navRow, viewRow] };
}

function decodeBugListCustomId(customId) {
  const [, mode, page, priority, search, targetDiscordId] = customId.split(':');
  return {
    mode,
    page: Number(page),
    priority: priority === '-' ? null : priority,
    search: search === '-' ? null : decodeURIComponent(search),
    targetDiscordId: targetDiscordId === '-' ? null : targetDiscordId,
  };
}

module.exports = { buildBugListPayload, decodeBugListCustomId, STATUS_LABELS };
