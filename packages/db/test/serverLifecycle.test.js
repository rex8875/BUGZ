const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

const DEV_ROLE = 'dev-discord-role';

async function setupServerWithMembers(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: DEV_ROLE, permissions: { canManageBugs: true, canViewDashboard: true } });
  return { server };
}

test('deactivating a server (bot kicked) removes dashboard access for EVERY member, including the owner', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);

  await withDiscordRoles({ owner1: [], dev1: [DEV_ROLE] }, async () => {
    assert.ok((await db.getEffectivePermissions(server.id, 'owner1'))?.canViewDashboard, 'sanity check before deactivation');
    assert.ok((await db.getEffectivePermissions(server.id, 'dev1'))?.canManageBugs, 'sanity check before deactivation');

    await db.deactivateServer('g1');

    assert.equal(await db.getEffectivePermissions(server.id, 'owner1'), null, 'owner should lose dashboard access too — the bot is gone for everyone equally');
    assert.equal(await db.getEffectivePermissions(server.id, 'dev1'), null);
  });
});

test('deactivating a server does NOT delete any data — configured role permissions and reports all survive', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  await db.createBugReport(server.id, 'owner1', { title: 'still here', description: 'd', priority: 'LOW', status: 'NEW' });

  await db.deactivateServer('g1');

  const configured = await db.listRolePermissions(server.id);
  assert.ok(configured.some((r) => r.discordRoleId === DEV_ROLE), 'role permission configuration should survive deactivation');

  const reports = await db.listBugReports(server.id);
  assert.equal(reports.length, 1, 'reports should survive deactivation');
});

test('re-inviting the bot (createServerOnJoin again) reactivates dashboard access automatically', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  await db.deactivateServer('g1');

  await withDiscordRoles({ dev1: [DEV_ROLE] }, async () => {
    assert.equal(await db.getEffectivePermissions(server.id, 'dev1'), null, 'sanity check: deactivated first');

    await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });

    const perms = await db.getEffectivePermissions(server.id, 'dev1');
    assert.ok(perms?.canManageBugs, 'role config and permissions should resume working immediately on reactivation, no re-setup needed');
  });
});

test('listAccessibleServers excludes deactivated servers from the dashboard picker', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  await withDiscordRoles({ dev1: [DEV_ROLE] }, async () => {
    assert.equal((await db.listAccessibleServers('dev1')).length, 1, 'sanity check: visible before deactivation');
    await db.deactivateServer('g1');
    assert.equal((await db.listAccessibleServers('dev1')).length, 0, 'should disappear from the picker once the bot is gone');
  });
});

test('a share-link guest also loses access when the server is deactivated', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW' });
  await db.verifyUser({ discordId: 'guest1', discordUsername: 'Guest' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' });

  await withDiscordRoles({ guest1: [] }, async () => {
    assert.ok(await db.getEffectivePermissions(server.id, 'guest1'), 'sanity check before deactivation');
    await db.deactivateServer('g1');
    assert.equal(await db.getEffectivePermissions(server.id, 'guest1'), null);
  });
});

test('hideLeaverFromLeaderboard only affects the leaderboard — everyone else, and the server itself, are unaffected', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);

  await db.hideLeaverFromLeaderboard(server.id, 'dev1');

  await withDiscordRoles({ owner1: [] }, async () => {
    assert.ok(await db.getEffectivePermissions(server.id, 'owner1'), 'the owner — and everyone else — must be completely unaffected');
  });

  const server2 = await db.getServerById(server.id);
  assert.equal(server2.isActive, true, 'the server itself must remain active — only the individual left, not the bot');
});

test('hideLeaverFromLeaderboard is a safe no-op for someone who never had any leaderboard score', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithMembers(db);
  await assert.doesNotReject(() => db.hideLeaverFromLeaderboard(server.id, 'never-scored-anything'));
});
