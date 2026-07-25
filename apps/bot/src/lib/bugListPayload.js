const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const STATUS_LABELS = {
  NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug',
  DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix",
};

function reportLine(r) {
  const link = `${process.env.WEB_BASE_URL}/r/${r.id}`;
  const archivedTag = r.archivedAt ? ' *(archived)*' : '';
  const date = new Date(r.createdAt).toLocaleDateString();
  return `**#${r.bugNumber} — ${r.title}**${archivedTag}\n${r.priority} · ${STATUS_LABELS[r.status] || r.status} · reported ${date} · [View](${link})`;
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
    .setFooter({ text: `Page ${page} of ${totalPages} · ${totalCount} report${totalCount === 1 ? '' : 's'}` });

  const encode = (p) => ['buglist', mode, p, priority || '-', encodeURIComponent((search || '-').slice(0, 40)), targetDiscordId || '-'].join(':');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(encode(page - 1)).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(encode(page + 1)).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
  );

  return { embeds: [embed], components: [row] };
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
