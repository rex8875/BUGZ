const drafts = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to fill out modal 2, short enough not to leak memory

function saveDraft(discordUserId, data) {
  drafts.set(discordUserId, { ...data, expiresAt: Date.now() + DRAFT_TTL_MS });
}

function getDraft(discordUserId) {
  const draft = drafts.get(discordUserId);
  if (!draft) return null;
  if (Date.now() > draft.expiresAt) {
    drafts.delete(discordUserId);
    return null;
  }
  const { expiresAt, ...data } = draft; // expiresAt is internal bookkeeping, never meant to leak to callers
  return data;
}

function clearDraft(discordUserId) {
  drafts.delete(discordUserId);
}

module.exports = { saveDraft, getDraft, clearDraft };
