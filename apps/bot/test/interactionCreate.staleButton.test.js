const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Reuses the exact fake-Prisma cache-swap technique from packages/db's own
// test suite (packages/db/test/helpers/loadDb.js) so we can load the real
// bot handler — interactionCreate.js — with a working @bugtracker/db
// underneath it, without a live database or `prisma generate`.
const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');

function loadInteractionCreateWithFakeDb() {
  const fakeClient = createFakePrismaClient();

  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = {
    id: prismaClientPath,
    filename: prismaClientPath,
    loaded: true,
    exports: { PrismaClient: function PrismaClient() { return fakeClient; } },
  };

  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];

  const handlerPath = require.resolve('../src/events/interactionCreate.js');
  delete require.cache[handlerPath];
  const draftsPath = require.resolve('../src/lib/bugReportDrafts.js');
  delete require.cache[draftsPath]; // fresh in-memory draft store per test

  const handler = require(handlerPath);
  const drafts = require(draftsPath);

  // restore prisma cache immediately; db module is already evaluated with the fake
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];

  return { handler, drafts, dbModulePath, originalDbCache };
}

function makeStaleButtonInteraction(userId) {
  const calls = { update: [], showModal: [] };
  return {
    calls,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    customId: 'continue_bug_report_modal2',
    user: { id: userId },
    update: async (payload) => { calls.update.push(payload); },
    showModal: async (modal) => { calls.showModal.push(modal); },
  };
}

test('clicking Continue after the draft is gone does NOT reopen the evidence modal (the originally reported bug)', async () => {
  const { handler, drafts, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  try {
    const userId = 'stale-click-user';
    // No draft ever saved for this user — simulates post-submission state.
    const interaction = makeStaleButtonInteraction(userId);

    await handler.execute(interaction);

    assert.equal(interaction.calls.showModal.length, 0, 'showModal must never be called for a stale click — this is the exact bug that was reported');
    assert.equal(interaction.calls.update.length, 1, 'the button message should be updated in place instead');
    assert.deepEqual(interaction.calls.update[0].components, [], 'the Continue button must be removed/disabled, not left clickable');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('clicking Continue while a draft is still live DOES open the evidence modal', async () => {
  const { handler, drafts, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  try {
    const userId = 'live-draft-user';
    drafts.saveDraft(userId, { title: 'Real in-progress bug' });
    const interaction = makeStaleButtonInteraction(userId);

    await handler.execute(interaction);

    assert.equal(interaction.calls.showModal.length, 1, 'a live draft should still be allowed to continue to the evidence modal');
    assert.equal(interaction.calls.update.length, 0);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
