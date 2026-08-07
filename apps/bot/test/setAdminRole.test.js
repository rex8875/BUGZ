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
  const cmdPath = require.resolve('../src/commands/set-admin-role.js');
  delete require.cache[cmdPath];
  const cmd = require(cmdPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { cmd, dbModule, dbModulePath, originalDbCache };
}

test('/set-admin-role stores the real Discord role id and confirms it links directly (not a separate bot role)', async () => {
  const { cmd, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });

    const interaction = {
      guildId: 'guild-1',
      user: { id: 'owner1' },
      options: { getRole: () => ({ id: 'tester-role-real-id', toString: () => '<@&tester-role-real-id>' }) },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await cmd.execute(interaction);

    assert.match(interaction._reply.content, /full access/i);
    const server = await dbModule.getServerByDiscordId('guild-1');
    const configured = await dbModule.listRolePermissions(server.id);
    const grant = configured.find((r) => r.discordRoleId === 'tester-role-real-id');
    assert.ok(grant, 'the real Discord role id should have a permission row now');
    assert.equal(grant.canManageSettings, true, 'set-admin-role should grant every permission flag, not a separate adminRoleId');
    assert.equal(grant.canBanMembers, true);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('/set-admin-role is rejected for someone without canManageSettings', async () => {
  const { cmd, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'nobody', discordUsername: 'Nobody' });

    const interaction = {
      guildId: 'guild-1',
      user: { id: 'nobody' },
      options: { getRole: () => ({ id: 'x', toString: () => '<@&x>' }) },
      reply: async (payload) => { interaction._reply = payload; },
    };
    await cmd.execute(interaction);
    assert.match(interaction._reply.content, /not permitted/i);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
