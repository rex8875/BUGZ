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

  await db.promoteMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'dev1', newRoleId: devRole.id });
  await db.promoteMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'peer1', newRoleId: peerRole.id });
  await db.promoteMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', newRoleId: testerRole.id });

  return { server, devRole, peerRole, testerRole };
}

test('promoteMember: cannot touch the role of someone currently ranked higher', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  // Dev (rank 50) tries to change Owner's (rank 100) role
  await assert.rejects(
    () => db.promoteMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'owner1', newRoleId: testerRole.id }),
    /server owner|at or above your own rank/,
  );
});

test('promoteMember: cannot touch a peer at exactly the same rank', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  // dev1 and peer1 are both rank 50
  await assert.rejects(
    () => db.promoteMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'peer1', newRoleId: testerRole.id }),
    /at or above your own rank/,
  );
});

test('promoteMember: cannot hand out a role at or above your own rank, even to someone clearly beneath you', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, devRole } = await setupTieredServer(db);
  // dev1 (rank 50) tries to promote tester1 (rank 10) to dev1's own role (rank 50)
  await assert.rejects(
    () => db.promoteMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', newRoleId: devRole.id }),
    /your own rank or above/,
  );
});

test('promoteMember: cannot ever change the recorded server owner\'s role, regardless of rank math', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await assert.rejects(
    () => db.promoteMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'owner1', newRoleId: testerRole.id }),
    /server owner/,
  );
});

test('promoteMember: succeeds for a genuinely lower-rank target getting a genuinely lower-rank role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  const newLowRole = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'Junior', rank: 5, permissions: {} });
  const result = await db.promoteMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', newRoleId: newLowRole.id });
  assert.equal(result.roleId, newLowRole.id);
});

test('promoteMember: refuses to promote a banned person until they are unbanned', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, testerRole } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });

  await assert.rejects(
    () => db.promoteMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', newRoleId: testerRole.id }),
    /banned/,
  );

  await db.unbanMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  const result = await db.promoteMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', newRoleId: testerRole.id });
  assert.ok(result, 'should succeed once unbanned');
});

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
