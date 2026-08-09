const test = require('node:test');
const assert = require('node:assert/strict');
const { installDiscordRoleMock } = require('../../../packages/db/test/helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

function loadWithFakeDb(handlerRelPath) {
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

  const handlerPath = require.resolve(handlerRelPath);
  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);

  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];

  return { handler, dbModule, dbModulePath, originalDbCache };
}

async function seed(dbModule, roleMock, { reportCount = 7 } = {}) {
  const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true, canViewDashboard: true } });
  roleMock.setMemberRoles('tester1', [TESTER_ROLE]);
  for (let i = 0; i < reportCount; i++) {
    await dbModule.createBugReport(server.id, 'tester1', {
      title: `Bug ${i}`, description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com',
    });
  }
  return server;
}

test('/my-bugs shows only the caller\'s reports, paginated, with a Next button when there is a second page', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/my-bugs.js');
  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 7 }); // pageSize is 5, so 7 reports = 2 pages

    const replies = [];
    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      reply: async (payload) => { replies.push(payload); },
    };

    await handler.execute(interaction);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    const nextBtn = replies[0].components[0].components.find((c) => c.data.label === 'Next ▶');
    assert.ok(nextBtn, 'should include a Next pagination button');
    assert.equal(nextBtn.data.disabled, false, 'Next should be enabled when there is a second page');
    const prevBtn = replies[0].components[0].components.find((c) => c.data.label === '◀ Previous');
    assert.equal(prevBtn.data.disabled, true, 'Previous should be disabled on page 1');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('/bugs-by shows the specified user\'s reports, not the caller\'s', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/bugs-by.js');
  const roleMock = installDiscordRoleMock();
  try {
    const server = await seed(dbModule, roleMock, { reportCount: 2 });

    const interaction = {
      guildId: 'g1',
      user: { id: 'owner1' }, // the caller is the owner...
      options: { getUser: () => ({ id: 'tester1', username: 'Tester1' }) }, // ...looking up tester1
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    assert.match(interaction._reply.embeds[0].data.title, /Tester1/);
    assert.match(interaction._reply.embeds[0].data.description, /Bug 0/);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('/bug looks up a single report by its number and shows it entirely in Discord, with no external link required', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/bug.js');
  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 3 });

    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      options: { getInteger: () => 2 },
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    const embed = interaction._reply.embeds[0].data;
    assert.match(embed.title, /^#2 —/);
    assert.equal(embed.url, undefined, 'the report is shown fully in-Discord now — no external link needed to see it');
    assert.equal(interaction._reply.ephemeral, true, 'should be a private reply, not posted to the whole channel');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('/bug replies with a plain not-found message for a nonexistent number', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/bug.js');
  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 1 });
    const interaction = {
      guildId: 'g1',
      user: { id: 'tester1' },
      options: { getInteger: () => 999 },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);
    assert.match(interaction._reply.content, /No bug #999/);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('/help lists every other command by scanning the commands directory, never hardcoded', async () => {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
  const fakeClient = createFakePrismaClient();
  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = { id: prismaClientPath, filename: prismaClientPath, loaded: true, exports: { PrismaClient: function () { return fakeClient; } } };
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];

  const fs = require('fs');
  const path = require('path');
  // Clear every command file from cache too, so they all re-require
  // @bugtracker/db while the fake is swapped in — otherwise whichever
  // one happened to load first (with the real Prisma client) poisons
  // the module cache for the rest.
  const commandFiles = fs.readdirSync(path.join(__dirname, '../src/commands')).filter((f) => f.endsWith('.js'));
  const originalCommandCaches = {};
  for (const file of commandFiles) {
    const p = require.resolve(path.join(__dirname, '../src/commands', file));
    originalCommandCaches[p] = require.cache[p];
    delete require.cache[p];
  }

  try {
    const cmd = require('../src/commands/help.js');
    const interaction = { reply: async (payload) => { interaction._reply = payload; } };
    await cmd.execute(interaction);

    const description = interaction._reply.embeds[0].data.description;
    for (const file of commandFiles.filter((f) => f !== 'help.js')) {
      const otherCmd = require(path.join(__dirname, '../src/commands', file));
      assert.match(description, new RegExp(`/${otherCmd.data.name}`), `/help should list /${otherCmd.data.name}`);
    }
  } finally {
    if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
    else delete require.cache[prismaClientPath];
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
    for (const [p, cache] of Object.entries(originalCommandCaches)) {
      if (cache) require.cache[p] = cache;
      else delete require.cache[p];
    }
  }
});

test('/list-bugs shows server-wide reports (not filtered to the caller), paginated', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/list-bugs.js');
  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 3 });

    const interaction = {
      guildId: 'g1',
      user: { id: 'owner1' }, // owner didn't report anything themselves, but is a member
      options: { getString: () => null },
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    assert.match(interaction._reply.embeds[0].data.description, /Bug 0/);
    assert.match(interaction._reply.embeds[0].data.description, /Bug 2/);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('/list-bugs rejects someone who holds no Discord role configured with dashboard access', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/list-bugs.js');
  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 1 });
    // deliberately not registered with the mock at all — matches
    // someone Discord reports a 404 for (not currently a guild member,
    // or the request otherwise finds no roles for them).
    const interaction = {
      guildId: 'g1',
      user: { id: 'not-a-member' },
      options: { getString: () => null },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await handler.execute(interaction);
    assert.match(interaction._reply.content, /don't have permission/i);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('clicking Next on a /my-bugs list updates the message in place with page 2', async () => {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
  const fakeClient = createFakePrismaClient();
  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = { id: prismaClientPath, filename: prismaClientPath, loaded: true, exports: { PrismaClient: function () { return fakeClient; } } };
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];
  const handlerPath = require.resolve('../src/events/interactionCreate.js');
  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];

  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 7 });

    const calls = [];
    const interaction = {
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'buglist:mine:2:-:-:tester1',
      guildId: 'g1',
      user: { id: 'tester1' },
      update: async (payload) => { calls.push(payload); },
    };

    await handler.execute(interaction);

    assert.equal(calls.length, 1);
    assert.match(calls[0].embeds[0].data.footer.text, /Page 2 of 2/);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('end-to-end: /list-bugs works while the role is held, then the exact same person is blocked the moment the role is taken away in Discord — no separate bot-side action needed', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb('../src/commands/list-bugs.js');
  const roleMock = installDiscordRoleMock();
  try {
    await seed(dbModule, roleMock, { reportCount: 1 });

    const interactionWithRole = {
      guildId: 'g1',
      user: { id: 'tester1' },
      options: { getString: () => null },
      reply: async (payload) => { interactionWithRole._reply = payload; },
    };
    await handler.execute(interactionWithRole);
    assert.ok(interactionWithRole._reply.embeds, '/list-bugs succeeds while the role is held');

    // Simulates the role being removed in Discord itself -- nothing
    // bot-side is called, we just flip what the live role lookup
    // reports for this person, exactly as a real removal would.
    roleMock.setMemberRoles('tester1', []);

    const interactionWithoutRole = {
      guildId: 'g1',
      user: { id: 'tester1' },
      options: { getString: () => null },
      reply: async (payload) => { interactionWithoutRole._reply = payload; },
    };
    await handler.execute(interactionWithoutRole);
    assert.match(interactionWithoutRole._reply.content, /don't have permission/i, '/list-bugs is blocked immediately after the role is gone, same process, no restart or cache clear involved');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
