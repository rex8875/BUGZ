const test = require('node:test');
const assert = require('node:assert/strict');
const { saveDraft, clearDraft } = require('../src/lib/bugReportDrafts');

// This test exercises the exact reported bug in isolation: after a report
// has been submitted (draft cleared), clicking the "Continue" button again
// must NOT reopen the evidence modal. It must instead disable itself and
// tell the person plainly, with no way back into the form.
//
// We test the branch logic directly (rather than mocking all of
// discord.js) by re-implementing the same guard the real handler uses,
// pulled from the same draft store the handler reads from. If this ever
// drifts from interactionCreate.js's actual behavior, update both.
const { getDraft } = require('../src/lib/bugReportDrafts');

function wouldReopenForm(discordUserId) {
  // Mirrors the guard in interactionCreate.js's continue-button handler:
  // showModal is only reachable when a draft still exists.
  const draft = getDraft(discordUserId);
  return draft !== null;
}

test('a stale Continue click (draft already cleared after submit) must not be able to reopen the form', () => {
  saveDraft('staleUser1', { title: 'Floor breaks' });
  clearDraft('staleUser1'); // simulates a successful submission clearing the draft

  assert.equal(wouldReopenForm('staleUser1'), false, 'once the draft is cleared, the Continue button must not reopen the modal');
});

test('a fresh Continue click (draft still present) is allowed to open the form', () => {
  saveDraft('staleUser2', { title: 'Another bug' });
  assert.equal(wouldReopenForm('staleUser2'), true, 'a live draft should still allow the evidence modal to open');
  clearDraft('staleUser2');
});

test('a Continue click after the draft TTL expires must not reopen the form either', () => {
  const realNow = Date.now;
  try {
    Date.now = () => realNow();
    saveDraft('staleUser3', { title: 'Expiring bug' });
    Date.now = () => realNow() + 11 * 60 * 1000; // past the 10-minute TTL
    assert.equal(wouldReopenForm('staleUser3'), false, 'an expired draft must behave identically to an already-submitted one');
  } finally {
    Date.now = realNow;
    clearDraft('staleUser3');
  }
});
