const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

async function setupTwoServers(db) {
  const serverA = await db.createServerOnJoin({ discordServerId: 'gA', name: 'Server A', ownerDiscordId: 'ownerA' });
  const serverB = await db.createServerOnJoin({ discordServerId: 'gB', name: 'Server B', ownerDiscordId: 'ownerB' });
  await db.verifyUser({ discordId: 'ownerA', discordUsername: 'OwnerA' });
  await db.verifyUser({ discordId: 'ownerB', discordUsername: 'OwnerB' });
  return { serverA, serverB };
}

test('a report created in server A never appears when listing server B\'s reports', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA, serverB } = await setupTwoServers(db);
  await db.createBugReport(serverA.id, 'ownerA', { title: 'A-only bug', description: 'd', priority: 'LOW', status: 'NEW' });

  const reportsB = await db.listBugReports(serverB.id);
  assert.equal(reportsB.length, 0);

  const reportsA = await db.listBugReports(serverA.id);
  assert.equal(reportsA.length, 1);
});

test('a leaked/guessed report id from server A cannot be mutated through server B\'s scope', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA, serverB } = await setupTwoServers(db);
  const report = await db.createBugReport(serverA.id, 'ownerA', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });

  await assert.rejects(
    () => db.updateBugReport({ serverId: serverB.id, actingDiscordId: 'ownerB', bugReportId: report.id, requestedChanges: { status: 'FIXED' } }),
    /not found/i,
    'the report exists, but not within server B\'s scope, so this must fail even though ownerB has full perms in their own server',
  );

  await assert.rejects(
    () => db.deleteBugReport({ serverId: serverB.id, actingDiscordId: 'ownerB', bugReportId: report.id }),
    /not found/i,
  );

  const stillThere = await db.getBugReport(serverA.id, report.id);
  assert.equal(stillThere.status, 'NEW');
});

test('the same Discord person, and even the SAME literal Discord role id, gives completely different permissions in two different servers', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA, serverB } = await setupTwoServers(db);
  await db.verifyUser({ discordId: 'multiserver', discordUsername: 'MultiServer' });

  const SHARED_ROLE_ID = 'shared-role-id'; // deliberately the same string in both servers
  await db.setRolePermissions({ serverId: serverA.id, actingDiscordId: 'ownerA', discordRoleId: SHARED_ROLE_ID, permissions: { canSubmitBugs: true } });
  await db.setRolePermissions({ serverId: serverB.id, actingDiscordId: 'ownerB', discordRoleId: SHARED_ROLE_ID, permissions: { canManageBugs: true, canManageRoles: true } });

  await withDiscordRoles({ multiserver: [SHARED_ROLE_ID] }, async () => {
    const permsA = await db.getEffectivePermissions(serverA.id, 'multiserver');
    const permsB = await db.getEffectivePermissions(serverB.id, 'multiserver');

    assert.equal(permsA.canManageBugs, false, 'in server A this role id was only configured for canSubmitBugs');
    assert.equal(permsB.canManageBugs, true, 'in server B the identical role id string was configured completely differently');
    assert.equal(permsB.canManageRoles, true);
  });
});

test('a ban in one server has zero effect on the same person\'s standing in another server', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA, serverB } = await setupTwoServers(db);
  await db.verifyUser({ discordId: 'multiserver', discordUsername: 'MultiServer' });
  await db.setRolePermissions({ serverId: serverA.id, actingDiscordId: 'ownerA', discordRoleId: 'role-a', permissions: { canSubmitBugs: true } });
  await db.setRolePermissions({ serverId: serverB.id, actingDiscordId: 'ownerB', discordRoleId: 'role-b', permissions: { canSubmitBugs: true } });

  await db.banMember({ serverId: serverA.id, actingDiscordId: 'ownerA', targetDiscordId: 'multiserver' });

  assert.equal(await db.isBanned(serverA.id, 'multiserver'), true);
  assert.equal(await db.isBanned(serverB.id, 'multiserver'), false, 'a ban in server A must not leak into server B');

  await withDiscordRoles({ multiserver: ['role-b'] }, async () => {
    assert.ok(await db.getEffectivePermissions(serverB.id, 'multiserver'), 'access in server B should be completely untouched');
  });
});

test('a share link created for server A grants no access whatsoever to server B', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA, serverB } = await setupTwoServers(db);
  const link = await db.createShareLink({ serverId: serverA.id, actingDiscordId: 'ownerA', accessLevel: 'DEV' });
  await db.verifyUser({ discordId: 'guest1', discordUsername: 'Guest' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' });

  await withDiscordRoles({ guest1: [] }, async () => {
    assert.ok((await db.getEffectivePermissions(serverA.id, 'guest1'))?.canManageBugs, 'sanity check: the link works for server A');
    assert.equal(await db.getEffectivePermissions(serverB.id, 'guest1'), null, 'the same guest must have zero standing in server B');
  });
});

test('leaderboard scores never mix between servers, even for the same person', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA, serverB } = await setupTwoServers(db);
  await db.verifyUser({ discordId: 'multiserver', discordUsername: 'MultiServer' });
  await db.setRolePermissions({ serverId: serverA.id, actingDiscordId: 'ownerA', discordRoleId: 'role-a', permissions: { canSubmitBugs: true } });
  await db.setRolePermissions({ serverId: serverB.id, actingDiscordId: 'ownerB', discordRoleId: 'role-b', permissions: { canSubmitBugs: true } });

  await withDiscordRoles({ multiserver: ['role-a'] }, async () => {
    await db.createBugReport(serverA.id, 'multiserver', { title: 'a1', description: 'd', priority: 'LOW', status: 'NEW' });
    await db.createBugReport(serverA.id, 'multiserver', { title: 'a2', description: 'd', priority: 'LOW', status: 'NEW' });
  });
  await withDiscordRoles({ multiserver: ['role-b'] }, async () => {
    await db.createBugReport(serverB.id, 'multiserver', { title: 'b1', description: 'd', priority: 'LOW', status: 'NEW' });
  });

  const scoreA = (await db.getLeaderboard(serverA.id)).find((s) => s.user.discordId === 'multiserver');
  const scoreB = (await db.getLeaderboard(serverB.id)).find((s) => s.user.discordId === 'multiserver');

  assert.equal(scoreA.points, 2);
  assert.equal(scoreB.points, 1);
});

test('listAccessibleServers only returns servers the person actually has standing in', async () => {
  const { db } = loadDbWithFakePrisma();
  const { serverA } = await setupTwoServers(db);
  await db.verifyUser({ discordId: 'onlyA', discordUsername: 'OnlyA' });
  await db.setRolePermissions({ serverId: serverA.id, actingDiscordId: 'ownerA', discordRoleId: 'role-a', permissions: { canSubmitBugs: true } });

  await withDiscordRoles({ onlyA: ['role-a'] }, async () => {
    const accessible = await db.listAccessibleServers('onlyA');
    assert.equal(accessible.length, 1);
    assert.equal(accessible[0].server.id, serverA.id);
  });
});
