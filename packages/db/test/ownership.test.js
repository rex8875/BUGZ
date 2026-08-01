const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

test('createServerOnJoin does not seed any roles — permissions come entirely from configuring real Discord roles later', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  const configured = await db.listRolePermissions(server.id);
  assert.equal(configured.length, 0, 'nothing should be pre-configured; there is no internal default role set anymore');
});

test('the recorded owner has full permissions automatically, with no role grant and no live Discord call needed', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'OwnerName' });

  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ roles: [] }) }; };
  try {
    const perms = await db.getEffectivePermissions(server.id, 'owner1');
    assert.equal(perms.canManageSettings, true);
    assert.equal(perms.canBanMembers, true);
    assert.equal(perms.canShareDashboard, true);
    assert.equal(fetchCalls, 0, 'the owner fast-path should never need a live Discord call');
  } finally {
    global.fetch = realFetch;
  }
});

test('someone who is NOT the recorded owner, and holds no configured role, has no permissions at all', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'rando', discordUsername: 'Rando' });

  await withDiscordRoles({ rando: [] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'rando');
    assert.equal(perms, null);
  });
});

test('re-joining an existing server updates the name but never silently changes the recorded owner', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.createServerOnJoin({ discordServerId: 'g1', name: 'Original Name', ownerDiscordId: 'owner1' });
  const updated = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Renamed', ownerDiscordId: 'someone-else' });

  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.ownerDiscordId, 'owner1', 'ownership must stay sticky even if the bot is re-invited by someone else');
});

test('only the current owner can transfer ownership', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });

  await assert.rejects(
    () => db.transferOwnership({ serverId: server.id, actingDiscordId: 'not-the-owner', newOwnerDiscordId: 'newowner' }),
    /Only the current owner/,
  );
});

test('cannot transfer ownership to someone who has not verified', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });

  await assert.rejects(
    () => db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'unverified-person' }),
    /has not verified/,
  );
});

test('successful transfer updates ownerDiscordId, and the new owner immediately has full permissions with no role grant needed', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });

  await db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'newowner' });

  const updatedServer = await db.getServerById(server.id);
  assert.equal(updatedServer.ownerDiscordId, 'newowner');

  const newOwnerPerms = await db.getEffectivePermissions(server.id, 'newowner');
  assert.equal(newOwnerPerms.canManageSettings, true);

  const oldOwnerPerms = await withDiscordRoles({ owner1: [] }, () => db.getEffectivePermissions(server.id, 'owner1'));
  assert.equal(oldOwnerPerms, null, 'the previous owner loses full access immediately — nothing to revoke, the check is live');
});

test('after transfer, the previous owner can no longer transfer ownership again', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });
  await db.verifyUser({ discordId: 'thirdparty', discordUsername: 'Third' });

  await db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'newowner' });

  await assert.rejects(
    () => db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'thirdparty' }),
    /Only the current owner/,
  );
});
