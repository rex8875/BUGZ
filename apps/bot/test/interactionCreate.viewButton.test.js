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

  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);

  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];

  return { handler, dbModule, dbModulePath, originalDbCache };
}

async function seedServerWithReport(dbModule, roleMock) {
  const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true, canViewDashboard: true } });
  roleMock.setMemberRoles('tester1', [TESTER_ROLE]);
  const report = await dbModule.createBugReport(server.id, 'tester1', {
    title: 'Floor breaks on level 3',
    description: 'Standing near the crate makes you fall through.',
    priority: 'HIGH',
    device: 'PC',
    evidenceLink: 'https://example.com/secret-clip',
    f9Link: 'https://example.com/secret-f9',
  });
  return { server, report };
}

test('clicking a "view:" button replies ephemerally with the full report — title, description, priority, status, device, reporter — with no external link', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const { report } = await seedServerWithReport(dbModule, roleMock);
    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      customId: `view:${report.id}`,
      isAutocomplete: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    const embed = interaction._reply.embeds[0].data;
    assert.match(embed.title, /Floor breaks on level 3/);
    assert.equal(embed.url, undefined, 'the in-Discord view should never link out to the website');
    assert.equal(interaction._reply.ephemeral, true, 'should be private to the clicker, not posted publicly');
    const fieldNames = embed.fields.map((f) => f.name);
    assert.ok(fieldNames.includes('Priority'));
    assert.ok(fieldNames.includes('Reported by'));
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('the "view:" button never leaks evidence/F9 links — same privacy contract as the public webpage', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const { report } = await seedServerWithReport(dbModule, roleMock);
    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      customId: `view:${report.id}`,
      isAutocomplete: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    const serialized = JSON.stringify(interaction._reply);
    assert.equal(serialized.includes('secret-clip'), false, 'evidence link must never appear in the in-Discord view');
    assert.equal(serialized.includes('secret-f9'), false, 'F9 link must never appear in the in-Discord view');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('the "view:" button re-checks permission live — someone who lost their role gets blocked, not a stale success', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const { report } = await seedServerWithReport(dbModule, roleMock);
    roleMock.setMemberRoles('tester1', []); // role removed after the list message was originally posted

    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      customId: `view:${report.id}`,
      isAutocomplete: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    assert.equal(interaction._reply.embeds, undefined, 'no report content should be shown once access is gone');
    assert.match(interaction._reply.content, /don't have permission/i);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('the "view:" button handles a since-deleted report gracefully, not a crash', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    await seedServerWithReport(dbModule, roleMock);
    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      customId: 'view:nonexistent-report-id',
      isAutocomplete: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);
    assert.match(interaction._reply.content, /no longer exists/i);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
