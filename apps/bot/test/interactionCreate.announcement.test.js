const test = require('node:test');
const assert = require('node:assert/strict');
const { installDiscordRoleMock } = require('../../../packages/db/test/helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

function loadInteractionCreateWithFakeDb() {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
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
  delete require.cache[draftsPath];

  const handler = require(handlerPath);
  const drafts = require(draftsPath);

  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];

  return { handler, drafts, dbModulePath, originalDbCache };
}

function makeModal2Interaction({ userId, guildId, fields, sendCalls }) {
  const fakeChannel = { send: async (payload) => { sendCalls.push(payload); return { id: 'announce-msg' }; } };
  const interaction = {
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    customId: 'bugReportModal2',
    user: { id: userId },
    guildId,
    message: { edit: async () => {} },
    client: { channels: { fetch: async () => fakeChannel } },
    fields: { getTextInputValue: (key) => fields[key] || '' },
    reply: async () => {},
    update: async (payload) => { interaction._update = payload; },
  };
  return interaction;
}

test('submitting a bug report posts a new-report announcement when an announce channel is configured', async () => {
  const { handler, drafts, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const realBaseUrl = process.env.WEB_BASE_URL;
  process.env.WEB_BASE_URL = 'https://bugz.example.com';
  const roleMock = installDiscordRoleMock();
  try {
    const dbModule = require(dbModulePath);
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'reporter1', discordUsername: 'Reporter' });
    const server = await dbModule.getServerByDiscordId('g1');
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
    roleMock.setMemberRoles('reporter1', [TESTER_ROLE]);
    await dbModule.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', announceChannelId: 'announce-chan' });

    drafts.saveDraft('reporter1', { title: 'Wall clips through floor', description: 'd', priority: 'LOW', device: 'PC' });

    const sendCalls = [];
    const interaction = makeModal2Interaction({
      userId: 'reporter1',
      guildId: 'g1',
      fields: { evidenceLink: 'https://example.com/e', f9Link: 'https://example.com/f9' },
      sendCalls,
    });

    await handler.execute(interaction);
    // The announcement is fired via a best-effort .then()/.catch() chain,
    // not awaited by the handler (so it can never delay/block the
    // reporter's confirmation) — give it a tick to actually run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sendCalls.length, 1, 'an announcement should have been posted');
    assert.match(sendCalls[0].content, /<@reporter1> reported their 1st bug/);
    assert.match(sendCalls[0].content, /https:\/\/bugz\.example\.com\/r\//);
  } finally {
    process.env.WEB_BASE_URL = realBaseUrl;
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('submitting the evidence modal updates the SAME message the Continue button was on — no separate new message, no stale button left behind', async () => {
  const { handler, drafts, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const dbModule = require(dbModulePath);
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'reporter1', discordUsername: 'Reporter' });
    const server = await dbModule.getServerByDiscordId('g1');
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
    roleMock.setMemberRoles('reporter1', [TESTER_ROLE]);

    drafts.saveDraft('reporter1', { title: 'Wall clips through floor', description: 'd', priority: 'LOW', device: 'PC' });

    const interaction = makeModal2Interaction({ userId: 'reporter1', guildId: 'g1', fields: { evidenceLink: 'https://example.com/e', f9Link: 'https://example.com/f9' }, sendCalls: [] });
    let replyWasCalled = false;
    interaction.reply = async () => { replyWasCalled = true; };

    await handler.execute(interaction);

    assert.equal(replyWasCalled, false, 'the outcome must be delivered by updating the existing message, not by sending a brand new separate one');
    assert.ok(interaction._update, 'the interaction should have been responded to via update()');
    assert.match(interaction._update.content, /Bug report submitted/);
    assert.deepEqual(interaction._update.components, [], 'the Continue button must be gone from the updated message, not left sitting there looking clickable');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('if creating the report fails validation, the SAME message is updated with the error and a fresh Continue button — not a separate error reply left next to a stale button', async () => {
  const { handler, drafts, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const dbModule = require(dbModulePath);
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'reporter1', discordUsername: 'Reporter' });
    const server = await dbModule.getServerByDiscordId('g1');
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
    roleMock.setMemberRoles('reporter1', [TESTER_ROLE]);

    drafts.saveDraft('reporter1', { title: 'Wall clips through floor', description: 'd', priority: 'LOW', device: 'PC' });

    // An invalid link should fail createBugReport's own validation.
    const interaction = makeModal2Interaction({ userId: 'reporter1', guildId: 'g1', fields: { evidenceLink: 'not-a-real-url', f9Link: 'https://example.com/f9' }, sendCalls: [] });
    let replyWasCalled = false;
    interaction.reply = async () => { replyWasCalled = true; };

    await handler.execute(interaction);

    assert.equal(replyWasCalled, false, 'the error should also update the same message, not send a separate reply');
    assert.ok(interaction._update, 'should have responded via update()');
    assert.ok(interaction._update.components.length > 0, 'a fresh Continue button should be present so the person can retry');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('submitting a bug report does NOT attempt to post an announcement when no announce channel is configured', async () => {
  const { handler, drafts, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const dbModule = require(dbModulePath);
    await dbModule.createServerOnJoin({ discordServerId: 'g2', name: 'Test2', ownerDiscordId: 'owner2' });
    await dbModule.verifyUser({ discordId: 'owner2', discordUsername: 'Owner2' });
    await dbModule.verifyUser({ discordId: 'reporter2', discordUsername: 'Reporter2' });
    const server = await dbModule.getServerByDiscordId('g2');
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner2', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
    roleMock.setMemberRoles('reporter2', [TESTER_ROLE]);
    // deliberately NOT setting announceChannelId

    drafts.saveDraft('reporter2', { title: 'Another bug', description: 'd', priority: 'LOW', device: 'PC' });

    const sendCalls = [];
    const interaction = makeModal2Interaction({
      userId: 'reporter2',
      guildId: 'g2',
      fields: { evidenceLink: 'https://example.com/e', f9Link: 'https://example.com/f9' },
      sendCalls,
    });

    await handler.execute(interaction);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sendCalls.length, 0, 'no announce channel configured means no announcement attempt');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
