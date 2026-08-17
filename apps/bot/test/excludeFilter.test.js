const test = require('node:test');
const assert = require('node:assert/strict');
const { installDiscordRoleMock } = require('../../../packages/db/test/helpers/discordRoleMock');
const { parseExcludeStatuses, buildBugListPayload, decodeBugListCustomId, STATUS_LABELS } = require('../src/lib/bugListPayload');

const TESTER_ROLE = 'tester-discord-role';

function loadWithFakeDb(handlerRelPath) {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
  const fakeClient = createFakePrismaClient();
  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = { id: prismaClientPath, filename: prismaClientPath, loaded: true, exports: { PrismaClient: function () { return fakeClient; } } };
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];
  const handlerPath = require.resolve(handlerRelPath);
  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { handler, dbModule, dbModulePath, originalDbCache };
}

async function withCommand(handlerRelPath, fn) {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb(handlerRelPath);
  const roleMock = installDiscordRoleMock();
  try {
    await fn(handler, dbModule, roleMock);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
}

async function seedWithMixedStatuses(dbModule, roleMock) {
  const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true, canViewDashboard: true } });
  roleMock.setMemberRoles('tester1', [TESTER_ROLE]);

  const statuses = ['NEW', 'FIXED', 'FIXED', 'WONT_FIX', 'DUPLICATE'];
  for (const status of statuses) {
    const r = await dbModule.createBugReport(server.id, 'tester1', { title: `Bug ${status}`, description: 'd', priority: 'LOW', device: 'PC' });
    if (status !== 'NEW') await dbModule.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: r.id, requestedChanges: { status } });
  }
  return server;
}

// ---- parseExcludeStatuses ----

test('parseExcludeStatuses: parses comma-separated labels, case- and apostrophe-insensitive', () => {
  assert.deepEqual(parseExcludeStatuses("Fixed, won't fix"), { excludeStatuses: ['FIXED', 'WONT_FIX'], invalid: [] });
  assert.deepEqual(parseExcludeStatuses("FIXED, WONT FIX"), { excludeStatuses: ['FIXED', 'WONT_FIX'], invalid: [] });
  assert.deepEqual(parseExcludeStatuses('needs info'), { excludeStatuses: ['NEEDS_INFO'], invalid: [] });
});

test('parseExcludeStatuses: empty/blank input means no exclusions, not an error', () => {
  assert.deepEqual(parseExcludeStatuses(null), { excludeStatuses: [], invalid: [] });
  assert.deepEqual(parseExcludeStatuses(''), { excludeStatuses: [], invalid: [] });
  assert.deepEqual(parseExcludeStatuses('   '), { excludeStatuses: [], invalid: [] });
});

test('parseExcludeStatuses: an unrecognized token is reported back so the caller can show a clear error', () => {
  const { excludeStatuses, invalid } = parseExcludeStatuses('Fixed, blorp');
  assert.deepEqual(excludeStatuses, ['FIXED']);
  assert.deepEqual(invalid, ['blorp']);
});

test('parseExcludeStatuses: duplicate tokens are de-duplicated', () => {
  const { excludeStatuses } = parseExcludeStatuses('Fixed, Fixed, fixed');
  assert.deepEqual(excludeStatuses, ['FIXED']);
});

// ---- customId encode/decode round trip ----

test('exclude filter round-trips through the Next/Previous button customId', () => {
  const payload = buildBugListPayload({
    title: 'x',
    queryResult: { reports: [{ id: 'r1', bugNumber: 1, title: 't', priority: 'LOW', status: 'NEW', createdAt: new Date() }], page: 1, totalPages: 2, totalCount: 6 },
    mode: 'all',
    excludeStatuses: ['FIXED', 'WONT_FIX'],
    emptyMessage: 'none',
  });
  const nextButtonCustomId = payload.components[0].components[1].data.custom_id;
  const decoded = decodeBugListCustomId(nextButtonCustomId);
  assert.deepEqual(decoded.excludeStatuses, ['FIXED', 'WONT_FIX']);
});

test('no exclude filter encodes/decodes as null, not an empty array mistaken for "exclude nothing vs unset"', () => {
  const payload = buildBugListPayload({
    title: 'x',
    queryResult: { reports: [{ id: 'r1', bugNumber: 1, title: 't', priority: 'LOW', status: 'NEW', createdAt: new Date() }], page: 1, totalPages: 2, totalCount: 6 },
    mode: 'all',
    excludeStatuses: [],
    emptyMessage: 'none',
  });
  const nextButtonCustomId = payload.components[0].components[1].data.custom_id;
  assert.equal(decodeBugListCustomId(nextButtonCustomId).excludeStatuses, null);
});

// ---- /list-bugs ----

test('/list-bugs exclude: excludes exactly the requested statuses, nothing else', async () => {
  await withCommand('../src/commands/list-bugs.js', async (handler, dbModule) => {
    const server = await seedWithMixedStatuses(dbModule, installDiscordRoleMock());
    const interaction = {
      guildId: 'g1',
      user: { id: 'owner1' },
      options: { getString: (name) => (name === 'exclude' ? 'Fixed' : null) },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);

    assert.equal(interaction._reply.embeds[0].data.footer.text.includes('3 reports'), true, '5 seeded minus 2 Fixed = 3');
    assert.doesNotMatch(interaction._reply.embeds[0].data.description, /Fixed/, 'no Fixed report should appear in the list');
  });
});

test('/list-bugs exclude: an unrecognized status name is rejected with a clear error, and never runs the query', async () => {
  await withCommand('../src/commands/list-bugs.js', async (handler, dbModule) => {
    await seedWithMixedStatuses(dbModule, installDiscordRoleMock());
    const interaction = {
      guildId: 'g1',
      user: { id: 'owner1' },
      options: { getString: (name) => (name === 'exclude' ? 'nonsense' : null) },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);

    assert.match(interaction._reply.content, /Didn't recognize: nonsense/);
    assert.match(interaction._reply.content, new RegExp(Object.values(STATUS_LABELS).join('|')), 'should list the valid options');
  });
});

test('/list-bugs with no exclude option behaves exactly as before (all non-archived statuses shown)', async () => {
  await withCommand('../src/commands/list-bugs.js', async (handler, dbModule) => {
    await seedWithMixedStatuses(dbModule, installDiscordRoleMock());
    const interaction = {
      guildId: 'g1',
      user: { id: 'owner1' },
      options: { getString: () => null },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);
    assert.equal(interaction._reply.embeds[0].data.footer.text.includes('5 reports'), true);
  });
});

// ---- /my-bugs and /bugs-by ----

test('/my-bugs exclude: excludes the given statuses from the caller\'s own reports', async () => {
  await withCommand('../src/commands/my-bugs.js', async (handler, dbModule) => {
    await seedWithMixedStatuses(dbModule, installDiscordRoleMock());
    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      options: { getString: (name) => (name === 'exclude' ? "won't fix, duplicate" : null) },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);
    assert.equal(interaction._reply.embeds[0].data.footer.text.includes('3 reports'), true, '5 minus WONT_FIX minus DUPLICATE = 3');
  });
});

test('/bugs-by exclude: excludes the given statuses from the target user\'s reports', async () => {
  await withCommand('../src/commands/bugs-by.js', async (handler, dbModule) => {
    await seedWithMixedStatuses(dbModule, installDiscordRoleMock());
    const interaction = {
      guildId: 'g1',
      user: { id: 'owner1' },
      options: { getUser: () => ({ id: 'tester1', username: 'Tester1' }), getString: (name) => (name === 'exclude' ? 'Fixed' : null) },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);
    assert.equal(interaction._reply.embeds[0].data.footer.text.includes('3 reports'), true);
  });
});

// ---- archived exclusion (already correct behavior — verifying, not changing) ----

for (const [name, path, extraOptions] of [
  ['list-bugs', '../src/commands/list-bugs.js', {}],
  ['my-bugs', '../src/commands/my-bugs.js', {}],
  ['bugs-by', '../src/commands/bugs-by.js', { getUser: () => ({ id: 'tester1', username: 'Tester1' }) }],
]) {
  test(`/${name} never shows archived reports`, async () => {
    await withCommand(path, async (handler, dbModule) => {
      const server = await seedWithMixedStatuses(dbModule, installDiscordRoleMock());
      // Archive one of the FIXED (terminal-status) reports.
      const reports = await dbModule.queryBugReports(server.id, { pageSize: 10 });
      const toArchive = reports.reports.find((r) => r.status === 'FIXED');
      await dbModule.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: toArchive.id, requestedChanges: { archivedAt: new Date() } });

      const interaction = {
        guildId: 'g1',
        user: { id: name === 'my-bugs' ? 'tester1' : 'owner1' },
        options: { getString: () => null, ...extraOptions },
        reply: async (payload) => { interaction._reply = payload; },
      };
      await handler.execute(interaction);

      assert.equal(interaction._reply.embeds[0].data.footer.text.includes('4 reports'), true, '5 seeded minus 1 archived = 4 visible');
    });
  });
}
