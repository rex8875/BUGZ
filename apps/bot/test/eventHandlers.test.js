const test = require('node:test');
const assert = require('node:assert/strict');
const { withDiscordRoles } = require('../../../packages/db/test/helpers/discordRoleMock');

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
  // guildCreate.js and ready.js both internally require registerGuild.js —
  // if that was cached from an earlier test in this file, it's holding a
  // reference to that test's now-discarded fake db instance, not this one.
  const registerGuildPath = require.resolve('../src/lib/registerGuild.js');
  delete require.cache[registerGuildPath];
  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { handler, dbModule, dbModulePath, originalDbCache };
}

async function withHandler(handlerRelPath, fn) {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb(handlerRelPath);
  try {
    await fn(handler, dbModule);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
}

test('guildDelete deactivates the server instead of leaving it live after the bot is removed', async () => {
  await withHandler('../src/events/guildDelete.js', async (handler, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await handler.execute({ id: 'g1' });

    const server = await dbModule.getServerByDiscordId('g1');
    assert.equal(server.isActive, false, 'the server should be marked inactive, not deleted outright (history stays intact)');
  });
});

test('guildDelete on an unknown guild does not crash', async () => {
  await withHandler('../src/events/guildDelete.js', async (handler) => {
    await assert.doesNotReject(() => handler.execute({ id: 'never-registered' }));
  });
});

test('guildMemberRemove hides the leaving member from the leaderboard', async () => {
  await withHandler('../src/events/guildMemberRemove.js', async (handler, dbModule) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
    await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
      await dbModule.createBugReport(server.id, 'tester1', { title: 'B', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com' });
    });
    assert.equal((await dbModule.getLeaderboard(server.id)).length, 1, 'sanity check: visible before leaving');

    await handler.execute({ guild: { id: 'g1' }, id: 'tester1' });

    assert.equal((await dbModule.getLeaderboard(server.id)).length, 0, 'guildMemberRemove should hide them from the leaderboard');
  });
});

test('guildMemberRemove does nothing if the server is not set up (no crash)', async () => {
  await withHandler('../src/events/guildMemberRemove.js', async (handler) => {
    await assert.doesNotReject(() => handler.execute({ guild: { id: 'unknown-guild' }, id: 'someone' }));
  });
});

test('registerGuild: falls back to the guild owner when audit-log lookup throws (e.g. missing View Audit Log permission)', async () => {
  await withHandler('../src/lib/registerGuild.js', async (handler, dbModule) => {
    const fakeGuild = {
      id: 'g1',
      name: 'Test Guild',
      ownerId: 'owner1',
      client: { user: { id: 'bot-id' } },
      iconURL: () => null,
      fetchAuditLogs: async () => { throw new Error('Missing Permissions'); },
    };
    await handler.registerGuild(fakeGuild);

    const server = await dbModule.getServerByDiscordId('g1');
    assert.equal(server.ownerDiscordId, 'owner1', 'should fall back to guild.ownerId when the audit log fetch fails');
  });
});

test('registerGuild: prefers the actual inviter from the audit log over the current guild owner, when available', async () => {
  await withHandler('../src/lib/registerGuild.js', async (handler, dbModule) => {
    const fakeGuild = {
      id: 'g1',
      name: 'Test Guild',
      ownerId: 'current-owner', // ownership may have transferred since the bot was invited
      client: { user: { id: 'bot-id' } },
      iconURL: () => 'https://example.test/icon.png',
      fetchAuditLogs: async () => ({
        entries: new Map([['e1', { target: { id: 'bot-id' }, executor: { id: 'original-inviter' } }]]),
      }),
    };
    // fetchAuditLogs().entries needs .find() — the real Discord.js Collection
    // has it; a plain Map does too as of Node 22, so this mirrors real shape closely enough
    fakeGuild.fetchAuditLogs = async () => ({
      entries: { find: (fn) => [{ target: { id: 'bot-id' }, executor: { id: 'original-inviter' } }].find(fn) },
    });
    await handler.registerGuild(fakeGuild);

    const server = await dbModule.getServerByDiscordId('g1');
    assert.equal(server.ownerDiscordId, 'original-inviter', 'should use the audit-log inviter, not guild.ownerId, when it is available');
  });
});

test('registerGuild: calling it twice for the same guild (join, then a startup reconciliation pass) does not create a duplicate server', async () => {
  await withHandler('../src/lib/registerGuild.js', async (handler, dbModule) => {
    const fakeGuild = {
      id: 'g1',
      name: 'Test Guild',
      ownerId: 'owner1',
      client: { user: { id: 'bot-id' } },
      iconURL: () => null,
      fetchAuditLogs: async () => { throw new Error('no perms'); },
    };
    await handler.registerGuild(fakeGuild);
    await handler.registerGuild(fakeGuild);

    const server = await dbModule.getServerByDiscordId('g1');
    assert.ok(server, 'should still resolve to one server');
  });
});

test('guildCreate delegates straight to registerGuild', async () => {
  await withHandler('../src/events/guildCreate.js', async (handler, dbModule) => {
    const fakeGuild = {
      id: 'g1', name: 'New Guild', ownerId: 'owner1',
      client: { user: { id: 'bot-id' } }, iconURL: () => null,
      fetchAuditLogs: async () => { throw new Error('no perms'); },
    };
    await handler.execute(fakeGuild);

    const server = await dbModule.getServerByDiscordId('g1');
    assert.ok(server, 'guildCreate should have registered the guild');
    assert.equal(server.name, 'New Guild');
  });
});

test('ready reconciles every guild the bot is already in, and one guild throwing does not stop the rest', async () => {
  await withHandler('../src/events/ready.js', async (handler, dbModule) => {
    const makeGuild = (id, shouldThrow) => ({
      id, name: `Guild ${id}`, ownerId: `owner-${id}`,
      client: { user: { id: 'bot-id' } }, iconURL: () => null,
      fetchAuditLogs: shouldThrow ? async () => { throw new Error('audit fetch failed'); } : async () => { throw new Error('no perms'); },
    });
    const fakeClient = {
      user: { tag: 'TestBot#0001' },
      guilds: { cache: new Map([['g1', makeGuild('g1')], ['g2', makeGuild('g2')], ['g3', makeGuild('g3')]]) },
    };

    await assert.doesNotReject(() => handler.execute(fakeClient));

    for (const id of ['g1', 'g2', 'g3']) {
      const server = await dbModule.getServerByDiscordId(id);
      assert.ok(server, `${id} should have been registered during startup reconciliation`);
    }
  });
});

test('ready: a guild that fails to register does not prevent the others from being reconciled', async () => {
  await withHandler('../src/events/ready.js', async (handler, dbModule) => {
    const goodGuild = { id: 'good', name: 'Good', ownerId: 'owner1', client: { user: { id: 'bot-id' } }, iconURL: () => null, fetchAuditLogs: async () => { throw new Error('no perms'); } };
    // registerGuild itself will throw if createServerOnJoin does (e.g. a
    // guild object missing required fields) — simulate that here.
    const badGuild = { id: null, name: null, ownerId: null, client: { user: { id: 'bot-id' } }, iconURL: () => null, fetchAuditLogs: async () => { throw new Error('no perms'); } };
    const fakeClient = {
      user: { tag: 'TestBot#0001' },
      guilds: { cache: new Map([['bad', badGuild], ['good', goodGuild]]) },
    };

    await assert.doesNotReject(() => handler.execute(fakeClient));
    assert.ok(await dbModule.getServerByDiscordId('good'), 'the good guild should still be registered despite the bad one failing');
  });
});
