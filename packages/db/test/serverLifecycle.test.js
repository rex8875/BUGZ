const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServerWithMembers(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });

  const devRole = await db.createRole({
    serverId: server.id, actingDiscordId: 'owner1', name: 'Dev', rank: 50,
    permissions: { canManageBugs: true },
  });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'dev1', roleId: devRole.id });

  return { server, devRole };
}

test('deactivating a server (bot kicked) removes dashboard access for EVERY member, including the owner', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);

  assert.ok((await db.getEffectivePermissions(server.id, 'owner1'))?.canViewDashboard, 'sanity check before deactivation');
  assert.ok((await db.getEffectivePermissions(server.id, 'dev1'))?.canManageBugs, 'sanity check before deactivation');

  await db.deactivateServer('g1');

  assert.equal(await db.getEffectivePermissions(server.id, 'owner1'), null, 'owner should lose dashboard access too — the bot is gone for everyone equally');
  assert.equal(await db.getEffectivePermissions(server.id, 'dev1'), null);
});

test('deactivating a server does NOT delete any data — roles, members, and reports all survive', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server, devRole } = await setupServerWithMembers(db);
  await db.createBugReport(server.id, 'owner1', { title: 'still here', description: 'd', priority: 'LOW', status: 'NEW' });

  await db.deactivateServer('g1');

  const roles = await db.listRoles(server.id);
  assert.ok(roles.some((r) => r.id === devRole.id), 'role definitions should survive deactivation');

  const reports = await db.listBugReports(server.id);
  assert.equal(reports.length, 1, 'reports should survive deactivation');

  const membership = await db.getMembership(server.id, 'dev1');
  assert.ok(membership, 'membership/role assignments should survive deactivation');
});

test('re-inviting the bot (createServerOnJoin again) reactivates dashboard access automatically', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  await db.deactivateServer('g1');
  assert.equal(await db.getEffectivePermissions(server.id, 'dev1'), null, 'sanity check: deactivated first');

  await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });

  const perms = await db.getEffectivePermissions(server.id, 'dev1');
  assert.ok(perms?.canManageBugs, 'role and permissions should resume working immediately on reactivation, no re-setup needed');
});

test('listAccessibleServers excludes deactivated servers from the dashboard picker', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  assert.equal((await db.listAccessibleServers('dev1')).length, 1, 'sanity check: visible before deactivation');

  await db.deactivateServer('g1');
  assert.equal((await db.listAccessibleServers('dev1')).length, 0, 'should disappear from the picker once the bot is gone');
});

test('a share-link guest also loses access when the server is deactivated', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW' });
  await db.verifyUser({ discordId: 'guest1', discordUsername: 'Guest' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' });
  assert.ok(await db.getEffectivePermissions(server.id, 'guest1'), 'sanity check before deactivation');

  await db.deactivateServer('g1');
  assert.equal(await db.getEffectivePermissions(server.id, 'guest1'), null);
});

test('removeMembershipOnLeave: removing one person\'s membership does not touch anyone else\'s access or the server itself', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);

  await db.removeMembershipOnLeave(server.id, 'dev1');

  assert.equal(await db.getMembership(server.id, 'dev1'), null, 'the leaving person should lose their membership');
  assert.ok(await db.getEffectivePermissions(server.id, 'owner1'), 'the owner — and everyone else — must be completely unaffected');

  const server2 = await db.getServerById(server.id);
  assert.equal(server2.isActive, true, 'the server itself must remain active — only the individual left, not the bot');
});

test('removeMembershipOnLeave is a safe no-op for someone who was never a member', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  await assert.doesNotReject(() => db.removeMembershipOnLeave(server.id, 'never-was-a-member'));
});
