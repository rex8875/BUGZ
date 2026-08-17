const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const STATUS_LABELS = {
  NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug',
  DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix",
};

// Single-letter codes for each status, used to keep the exclude list
// compact inside a button customId (Discord caps those at 100 chars).
const STATUS_CODES = { NEW: 'N', NEEDS_INFO: 'I', FIXED: 'F', NOT_A_BUG: 'B', DUPLICATE: 'D', WONT_FIX: 'W' };
const CODE_TO_STATUS = Object.fromEntries(Object.entries(STATUS_CODES).map(([status, code]) => [code, status]));

function encodeExcludeStatuses(excludeStatuses) {
  if (!excludeStatuses || !excludeStatuses.length) return '-';
  return excludeStatuses.map((s) => STATUS_CODES[s]).join('');
}

function decodeExcludeStatuses(encoded) {
  if (!encoded || encoded === '-') return null;
  return [...encoded].map((code) => CODE_TO_STATUS[code]).filter(Boolean);
}

// Parses a free-typed "Fixed, Won't fix" style option into validated
// status values — matched case-insensitively and apostrophe-insensitive
// (so "wont fix", "Won't Fix", "WONT FIX" all resolve the same way),
// since this is typed text, not a native multi-select (Discord slash
// command options don't support one for a single string option).
function normalizeStatusLabel(s) {
  return s.trim().toLowerCase().replace(/['’]/g, '');
}
const LABEL_LOOKUP = Object.fromEntries(Object.entries(STATUS_LABELS).map(([status, label]) => [normalizeStatusLabel(label), status]));

function parseExcludeStatuses(input) {
  if (!input || !input.trim()) return { excludeStatuses: [], invalid: [] };
  const tokens = input.split(',').map((t) => t.trim()).filter(Boolean);
  const excludeStatuses = [];
  const invalid = [];
  for (const token of tokens) {
    const status = LABEL_LOOKUP[normalizeStatusLabel(token)];
    if (status) excludeStatuses.push(status);
    else invalid.push(token);
  }
  return { excludeStatuses: [...new Set(excludeStatuses)], invalid };
}

function reportLine(r) {
  const archivedTag = r.archivedAt ? ' *(archived)*' : '';
  const date = new Date(r.createdAt).toLocaleDateString();
  return `**#${r.bugNumber} — ${r.title}**${archivedTag}\n${r.priority} · ${STATUS_LABELS[r.status] || r.status} · reported ${date}`;
}

// mode/priority/search/targetDiscordId/excludeStatuses are round-tripped
// through the Prev/Next button customIds so a page click can re-run the
// exact same query — kept short since Discord customIds cap at 100
// characters (see encodeExcludeStatuses for why exclude uses 1-letter
// codes rather than the full status names).
function buildBugListPayload({ title, queryResult, mode, priority, search, targetDiscordId, excludeStatuses, emptyMessage }) {
  const { reports, page, totalPages, totalCount } = queryResult;

  if (totalCount === 0) {
    return { content: emptyMessage, embeds: [], components: [] };
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865f2)
    .setDescription(reports.map(reportLine).join('\n\n'))
    .setFooter({ text: `Page ${page} of ${totalPages} · ${totalCount} report${totalCount === 1 ? '' : 's'} · tap a # below to view one` });

  const encode = (p) =>
    ['buglist', mode, p, priority || '-', encodeURIComponent((search || '-').slice(0, 40)), targetDiscordId || '-', encodeExcludeStatuses(excludeStatuses)].join(':');

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
  const [, mode, page, priority, search, targetDiscordId, excludeStatusesEncoded] = customId.split(':');
  return {
    mode,
    page: Number(page),
    priority: priority === '-' ? null : priority,
    search: search === '-' ? null : decodeURIComponent(search),
    targetDiscordId: targetDiscordId === '-' ? null : targetDiscordId,
    excludeStatuses: decodeExcludeStatuses(excludeStatusesEncoded),
  };
}

module.exports = { buildBugListPayload, decodeBugListCustomId, parseExcludeStatuses, STATUS_LABELS };
