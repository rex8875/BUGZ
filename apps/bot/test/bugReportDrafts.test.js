const test = require('node:test');
const assert = require('node:assert/strict');
const { saveDraft, getDraft, clearDraft } = require('../src/lib/bugReportDrafts');

test('a saved draft can be retrieved with the same data', () => {
  saveDraft('user1', { title: 'Floor breaks' });
  const draft = getDraft('user1');
  assert.equal(draft.title, 'Floor breaks');
  clearDraft('user1');
});

test('clearing a draft makes it unretrievable', () => {
  saveDraft('user2', { title: 'temp' });
  clearDraft('user2');
  assert.equal(getDraft('user2'), null);
});

test('drafts are isolated per user', () => {
  saveDraft('userA', { title: 'A' });
  saveDraft('userB', { title: 'B' });
  assert.equal(getDraft('userA').title, 'A');
  assert.equal(getDraft('userB').title, 'B');
  clearDraft('userA');
  clearDraft('userB');
});

test('saving a new draft for the same user overwrites the previous one', () => {
  saveDraft('user3', { title: 'first attempt' });
  saveDraft('user3', { title: 'second attempt' });
  assert.equal(getDraft('user3').title, 'second attempt');
  clearDraft('user3');
});

test('getDraft on a user with no saved draft returns null', () => {
  assert.equal(getDraft('never-saved-anything'), null);
});

test('a draft expires after its TTL and getDraft returns null past that point', () => {
  const realNow = Date.now;
  try {
    Date.now = () => realNow() ; // baseline, t=0
    saveDraft('user5', { title: 'will expire' });
    assert.ok(getDraft('user5'), 'should be retrievable immediately');

    Date.now = () => realNow() + 11 * 60 * 1000; // simulate 11 minutes passing (TTL is 10)
    assert.equal(getDraft('user5'), null, 'should be expired and gone after the TTL window');
  } finally {
    Date.now = realNow;
    clearDraft('user5');
  }
});
