const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

// Discord role ids used across these tests, with a fixed live hierarchy:
// DEV_ROLE and PEER_ROLE sit at the same position (peers); TESTER_ROLE
// is junior to both. There is deliberately no internal rank field
// anymore — this all comes from Discord's own live role positions.
const DEV_ROLE = 'dev-role';
const PEER_ROLE = 'peer-role';
const TESTER_ROLE = 'tester-role';

async function setupTieredServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });
  await db.verifyUser({ discordId: 'peer1', discordUsername: 'Peer' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });

  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: DEV_ROLE, permissions: { canManageRoles: true } });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: PEER_ROLE, permissions: {} });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  return { server };
}

function tieredPositions(mock) {
  mock.setRolePosition(DEV_ROLE, 50);
  mock.setRolePosition(PEER_ROLE, 50);
  mock.setRolePosition(TESTER_ROLE, 10);
}

test('setRolePermissions: cannot configure a role at or above your own live Discord role position', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE] }, async (mock) => {
    tieredPositions(mock);
    // dev1 (position 50) cannot configure the Peer role (also 50)
    await assert.rejects(
      () => db.setRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', discordRoleId: PEER_ROLE, permissions: { canManageSettings: true } }),
      /at or above your own role position/,
    );
  });
});

test('setRolePermissions: a Discord role position ceiling alone makes a senior role untouchable — no separate owner-check needed for the check itself', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE] }, async (mock) => {
    mock.setRolePosition(DEV_ROLE, 50);
    mock.setRolePosition('senior-role', 90);
    await assert.rejects(
      () => db.setRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', discordRoleId: 'senior-role', permissions: { canManageSettings: true } }),
      /at or above your own role position/,
    );
  });
});

test('setRolePermissions: the server owner bypasses the position check entirely, even holding no configured role themselves', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ owner1: [] }, async (mock) => {
    tieredPositions(mock);
    mock.setRolePosition('very-senior-role', 999);
    await assert.doesNotReject(
      () => db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: 'very-senior-role', permissions: { canManageSettings: true } }),
    );
  });
});

test('setRolePermissions: configuring a genuinely junior role succeeds', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE] }, async (mock) => {
    tieredPositions(mock);
    const updated = await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', discordRoleId: TESTER_ROLE, permissions: { canManageBugs: true } });
    assert.equal(updated.canManageBugs, true);
  });
});

test('setRolePermissions: re-configuring an already-configured role updates it (upsert), not a duplicate row', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true, canManageBugs: true } });

  const all = await db.listRolePermissions(server.id);
  assert.equal(all.filter((r) => r.discordRoleId === TESTER_ROLE).length, 1);
  assert.equal(all.find((r) => r.discordRoleId === TESTER_ROLE).canManageBugs, true);
});

test('setRolePermissions: configuring one role never affects another role\'s permissions', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canManageSettings: true } });

  const devConfig = (await db.listRolePermissions(server.id)).find((r) => r.discordRoleId === DEV_ROLE);
  assert.equal(devConfig.canManageSettings, false, 'the Dev role must be untouched by reconfiguring Tester');
});

test('a person holding TWO configured roles gets the union (OR) of both role\'s permissions', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.verifyUser({ discordId: 'multi1', discordUsername: 'Multi' });

  await withDiscordRoles({ multi1: [DEV_ROLE, TESTER_ROLE] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'multi1');
    assert.equal(perms.canManageRoles, true, 'from Dev');
    assert.equal(perms.canSubmitBugs, true, 'from Tester');
  });
});

test('deleteRolePermissions: cannot modify a role at or above your own position', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE] }, async (mock) => {
    tieredPositions(mock);
    await assert.rejects(
      () => db.deleteRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', discordRoleId: PEER_ROLE }),
      /at or above your own role position/,
    );
  });
});

test('deleteRolePermissions: clears a role back to zero configured permissions (no access), and is safe to call on an unconfigured role too', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.deleteRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE });

  const all = await db.listRolePermissions(server.id);
  assert.ok(!all.some((r) => r.discordRoleId === TESTER_ROLE));

  await assert.doesNotReject(() => db.deleteRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: 'never-configured-role' }));
});

test('setRolePermissions/deleteRolePermissions require canManageRoles', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await assert.rejects(
      () => db.setRolePermissions({ serverId: server.id, actingDiscordId: 'tester1', discordRoleId: 'whatever', permissions: {} }),
      /Not permitted/,
    );
    await assert.rejects(
      () => db.deleteRolePermissions({ serverId: server.id, actingDiscordId: 'tester1', discordRoleId: DEV_ROLE }),
      /Not permitted/,
    );
  });
});

test('role permission configuration is scoped per server — the same Discord role id means nothing in a server where it was never configured', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  const otherServer = await db.createServerOnJoin({ discordServerId: 'gOther', name: 'Other', ownerDiscordId: 'otherOwner' });
  await db.verifyUser({ discordId: 'otherOwner', discordUsername: 'OtherOwner' });

  const otherConfig = await db.listRolePermissions(otherServer.id);
  assert.equal(otherConfig.length, 0);

  const thisConfig = await db.listRolePermissions(server.id);
  assert.ok(thisConfig.length > 0, 'sanity check: the original server does have configuration');
});

test('listRolePermissions returns exactly what was configured, nothing extra', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  const all = await db.listRolePermissions(server.id);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.discordRoleId).sort(), [DEV_ROLE, PEER_ROLE, TESTER_ROLE].sort());
});
