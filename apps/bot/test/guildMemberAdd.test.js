const test = require('node:test');
const assert = require('node:assert/strict');

function loadWithFakeDb() {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
  const fakeClient = createFakePrismaClient();
  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = { id: prismaClientPath, filename: prismaClientPath, loaded: true, exports: { PrismaClient: function () { return fakeClient; } } };
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];
  const handlerPath = require.resolve('../src/events/guildMemberAdd.js');
  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { handler, dbModule, dbModulePath, originalDbCache };
}

test('guildMemberAdd restores leaderboard visibility for a rejoining member who was previously hidden', async () => {
  const { handler, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
    const testerRole = (await dbModule.listRoles(server.id)).find((r) => r.name === 'Tester');
    await dbModule.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
    await dbModule.createBugReport(server.id, 'tester1', { title: 'B', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com' });
    await dbModule.removeMembershipOnLeave(server.id, 'tester1');
    assert.equal((await dbModule.getLeaderboard(server.id)).length, 0, 'sanity check: hidden after leaving');

    const fakeMember = { guild: { id: 'g1' }, id: 'tester1' };
    await handler.execute(fakeMember);

    assert.equal((await dbModule.getLeaderboard(server.id)).length, 1, 'guildMemberAdd should have restored visibility');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('guildMemberAdd does nothing if the server is not set up (no crash)', async () => {
  const { handler, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    const fakeMember = { guild: { id: 'unknown-guild' }, id: 'someone' };
    await assert.doesNotReject(() => handler.execute(fakeMember));
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
