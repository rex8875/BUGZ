const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupTieredServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });
  await db.verifyUser({ discordId: 'peer1', discordUsername: 'Peer' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });

  const devRole = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'Dev', rank: 50, permissions: { canManageRoles: true } });
  const peerRole = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'Peer', rank: 50, permissions: {} });
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');

  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'dev1', roleId: devRole.id });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'peer1', roleId: peerRole.id });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });

  return { server, devRole, peerRole, testerRole };
}

// ---- grantRole ----

test('grantRole: cannot grant a role at or above your own (effective) rank', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, devRole, testerRole } = await setupTieredServer(db);
  await assert.rejects(
    () => db.grantRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', roleId: devRole.id }),
    /at or above your own rank/,
  );
  // Dev (rank 50) also can't grant the Peer role (also rank 50)
  const peerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Peer');
  await assert.rejects(
    () => db.grantRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', roleId: peerRole.id }),
    /at or above your own rank/,
  );
});

test('grantRole: the Discord-style case — a Dev can give the Tester tag to someone who ALSO holds Owner, without touching their Owner role at all', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);

  // owner1 already holds Owner (rank 100) from auto-claim. dev1 (rank 50)
  // grants them the Tester role (rank 10) too — should succeed, since the
  // check is about the role being granted (10 < 50), not about what else
  // owner1 holds.
  await db.grantRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'owner1', roleId: testerRole.id });

  const membership = await db.getMembership(server.id, 'owner1');
  const roleNames = membership.roles.map((mr) => mr.role.name).sort();
  assert.deepEqual(roleNames, ['Owner', 'Tester'], 'owner1 should now hold BOTH roles, not have Owner replaced');
});

test('grantRole: refuses to grant to a banned person until they are unbanned', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });

  await assert.rejects(
    () => db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id }),
    /banned/,
  );

  await db.unbanMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  await assert.doesNotReject(() => db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id }));
});

test('grantRole: granting a role you already hold is a harmless no-op, not a duplicate', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  const membership = await db.getMembership(server.id, 'tester1');
  assert.equal(membership.roles.length, 1);
});

test('grantRole: works for a brand-new person who has no membership at all yet', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await db.verifyUser({ discordId: 'brandnew', discordUsername: 'BrandNew' });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'brandnew', roleId: testerRole.id });
  const membership = await db.getMembership(server.id, 'brandnew');
  assert.equal(membership.roles[0].role.name, 'Tester');
});

// ---- revokeRole ----

test('revokeRole: cannot revoke a role at or above your own rank', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, devRole } = await setupTieredServer(db);
  const peerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Peer');
  await assert.rejects(
    () => db.revokeRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'peer1', roleId: peerRole.id }),
    /at or above your own rank/,
    'a Dev cannot revoke the Peer role (same rank as Dev) from anyone, even though dev1 is just acting on peer1',
  );
});

test('grantRole: the rank ceiling alone makes the Owner role itself untouchable by anyone below rank 100 — no separate owner-check needed', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  const ownerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Owner');
  await assert.rejects(
    () => db.grantRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', roleId: ownerRole.id }),
    /at or above your own rank/,
  );
});

test('revokeRole: even the owner cannot self-revoke their own Owner role via this path (rank check uses >=, not >) — that path is transferOwnership instead', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  const ownerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Owner');
  await assert.rejects(
    () => db.revokeRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'owner1', roleId: ownerRole.id }),
    /at or above your own rank/,
  );
});

test('revokeRole: the Discord-style case — a Dev can take away the Tester tag from someone who also holds Owner, without touching their Owner role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await db.grantRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'owner1', roleId: testerRole.id });

  await db.revokeRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'owner1', roleId: testerRole.id });

  const membership = await db.getMembership(server.id, 'owner1');
  const roleNames = membership.roles.map((mr) => mr.role.name);
  assert.deepEqual(roleNames, ['Owner'], 'Owner role must remain untouched after the Tester tag is removed');
});

test('revokeRole: revoking someone\'s last role cleans up their membership entirely', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await db.revokeRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  const membership = await db.getMembership(server.id, 'tester1');
  assert.equal(membership, null, 'holding zero roles should mean no membership row at all');
});

test('revokeRole: throws clearly if the person does not actually hold that role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await assert.rejects(
    () => db.revokeRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'dev1', roleId: testerRole.id }),
    /does not hold this role/,
  );
});

// ---- createRole / updateRolePermissions / deleteRole (rank ceilings + naming) ----

test('createRole: cannot create a role at or above your own rank', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await assert.rejects(
    () => db.createRole({ serverId: server.id, actingDiscordId: 'dev1', name: 'TooHigh', rank: 50 }),
    /at or above your own rank/,
  );
});

test('updateRolePermissions: cannot edit a role at or above your own rank, nor raise a role to your rank', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, devRole, testerRole } = await setupTieredServer(db);

  await assert.rejects(
    () => db.updateRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', roleId: devRole.id, permissions: { canManageSettings: true } }),
    /own rank/,
    'editing your own rank-level role (held by a peer) should be blocked',
  );

  await assert.rejects(
    () => db.updateRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', roleId: testerRole.id, permissions: { rank: 50 } }),
    /own rank/,
    'raising a lower role up to your own rank should be blocked even though editing it is otherwise fine',
  );
});

test('updateRolePermissions: rank can be edited (lowered or raised, as long as it stays below your own rank) — this is the "edit rank" capability', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  const updated = await db.updateRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', roleId: testerRole.id, permissions: { rank: 20 } });
  assert.equal(updated.rank, 20);
});

test('createRole rejects a name that already exists in this server, with a friendly message instead of a raw database error', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await assert.rejects(
    () => db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'Dev', rank: 5 }),
    /already exists/,
  );
});

test('createRole allows the same name in a different server (the uniqueness is per-server, not global)', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  const otherServer = await db.createServerOnJoin({ discordServerId: 'gOther', name: 'Other', ownerDiscordId: 'otherOwner' });
  await db.verifyUser({ discordId: 'otherOwner', discordUsername: 'OtherOwner' });
  await assert.doesNotReject(() => db.createRole({ serverId: otherServer.id, actingDiscordId: 'otherOwner', name: 'Dev', rank: 5 }));
});

test('updateRolePermissions rejects renaming a role to a name already used by another role in the same server', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await assert.rejects(
    () => db.updateRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', roleId: testerRole.id, permissions: { name: 'Dev' } }),
    /already exists/,
  );
});

test('updateRolePermissions allows "renaming" a role to its own current name (a no-op, not a collision)', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await assert.doesNotReject(() =>
    db.updateRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', roleId: testerRole.id, permissions: { name: 'Tester', canSubmitBugs: false } }),
  );
});

test('deleteRole: cannot delete a role that still has members holding it', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await assert.rejects(
    () => db.deleteRole({ serverId: server.id, actingDiscordId: 'owner1', roleId: testerRole.id }),
    /still hold this role/,
  );
});

test('deleteRole: succeeds once no one holds the role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  const unused = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'Unused', rank: 1 });
  await db.deleteRole({ serverId: server.id, actingDiscordId: 'owner1', roleId: unused.id });
  const roles = await db.listRoles(server.id);
  assert.ok(!roles.some((r) => r.id === unused.id));
});
