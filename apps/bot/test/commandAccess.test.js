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
  const accessPath = require.resolve('../src/lib/commandAccess.js');
  delete require.cache[accessPath];
  const { checkCommandAccess } = require(accessPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { checkCommandAccess, dbModule, dbModulePath, originalDbCache };
}

function fakeMember(roleIds, { admin = false } = {}) {
  return {
    permissions: { has: (perm) => admin && perm === 'Administrator' },
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  };
}

test('a command with no configured override is always allowed (default fallback behavior)', async () => {
  const { checkCommandAccess, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    const interaction = { guildId: 'g1', user: { id: 'anyone' }, member: fakeMember([]) };
    const result = await checkCommandAccess(interaction, 'reset-score');
    assert.equal(result.allowed, true);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('a configured override denies a user who lacks any of the allowed Discord roles', async () => {
  const { checkCommandAccess, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['qa-role'] });

    const interaction = { guildId: 'g1', user: { id: 'random-user' }, member: fakeMember(['some-other-role']) };
    const result = await checkCommandAccess(interaction, 'reset-score');
    assert.equal(result.allowed, false);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('a configured override allows a user who holds one of the allowed Discord roles', async () => {
  const { checkCommandAccess, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['qa-role', 'mod-role'] });

    const interaction = { guildId: 'g1', user: { id: 'qa-person' }, member: fakeMember(['some-other-role', 'mod-role']) };
    const result = await checkCommandAccess(interaction, 'reset-score');
    assert.equal(result.allowed, true);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('real Discord Administrator permission always bypasses a configured override (cannot lock out real admins)', async () => {
  const { checkCommandAccess, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['qa-role'] });

    const interaction = { guildId: 'g1', user: { id: 'server-admin' }, member: fakeMember([], { admin: true }) };
    const result = await checkCommandAccess(interaction, 'reset-score');
    assert.equal(result.allowed, true);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('internal canManageSettings also bypasses a configured override (the owner cannot lock themselves out)', async () => {
  const { checkCommandAccess, dbModule, dbModulePath, originalDbCache } = loadWithFakeDb();
  try {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['qa-role'] });

    // owner1 has neither the qa-role nor literal Discord Administrator
    // here, but IS the recorded server owner (full internal permissions).
    const interaction = { guildId: 'g1', user: { id: 'owner1' }, member: fakeMember([]) };
    const result = await checkCommandAccess(interaction, 'reset-score');
    assert.equal(result.allowed, true);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('a DM interaction (no guildId) is allowed through here, deferring to the command\'s own guild-only handling', async () => {
  const { checkCommandAccess } = loadWithFakeDb();
  const interaction = { guildId: null, user: { id: 'someone' }, member: null };
  const result = await checkCommandAccess(interaction, 'reset-score');
  assert.equal(result.allowed, true);
});

test('end-to-end: interactionCreate.js actually blocks a restricted command for a user without the role', async () => {
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
  const accessPath = require.resolve('../src/lib/commandAccess.js');
  delete require.cache[accessPath]; // was cached from an earlier test against a different fake db instance
  const handler = require(handlerPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];

  try {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['special-role'] });

    let executed = false;
    const interaction = {
      isAutocomplete: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'reset-score',
      guildId: 'g1',
      user: { id: 'blocked-user' },
      member: fakeMember(['unrelated-role']),
      client: { commands: { get: () => ({ execute: async () => { executed = true; } }) } },
      reply: async (payload) => { interaction._reply = payload; },
    };

    await handler.execute(interaction);

    assert.equal(executed, false, 'the command itself must never run when access is denied');
    assert.match(interaction._reply.content, /don't have permission/i);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
