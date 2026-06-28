const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServerWithDevAndTester(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });

  const devRole = await db.createRole({
    serverId: server.id,
    actingDiscordId: 'owner1',
    name: 'Dev',
    rank: 50,
    permissions: { canSubmitBugs: true, canViewDashboard: true, canManageBugs: true, canPingTesters: true, canArchive: true, canEditReports: true, canDeleteReports: true },
  });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'dev1', roleId: devRole.id });

  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });

  return { server, devRole, testerRole };
}

test('getEffectivePermissions: member shape carries every flag from their role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);

  const perms = await db.getEffectivePermissions(server.id, 'dev1');
  assert.equal(perms.source, 'member');
  assert.equal(perms.canManageBugs, true);
  assert.equal(perms.canManageRoles, false, 'Dev role here was not granted role management');
});

test('getEffectivePermissions: returns null for someone with no membership and no guest access', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const perms = await db.getEffectivePermissions(server.id, 'totally-unrelated-person');
  assert.equal(perms, null);
});

test('guest (View access) gets read-only dashboard access and nothing else, even Dev-tier powers', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW', label: 'contractor' });
  await db.verifyUser({ discordId: 'guest1', discordUsername: 'Guest' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' });

  const perms = await db.getEffectivePermissions(server.id, 'guest1');
  assert.equal(perms.source, 'guest');
  assert.equal(perms.canViewDashboard, true);
  assert.equal(perms.canManageBugs, false);
  assert.equal(perms.canArchive, false);
  assert.equal(perms.canShareDashboard, false);
  assert.equal(perms.canKickMembers, false);
});

test('guest (Dev access) gets report-management powers but never governance powers', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'DEV' });
  await db.verifyUser({ discordId: 'guest2', discordUsername: 'GuestDev' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest2' });

  const perms = await db.getEffectivePermissions(server.id, 'guest2');
  assert.equal(perms.canManageBugs, true);
  assert.equal(perms.canPingTesters, true);
  assert.equal(perms.canArchive, true);
  assert.equal(perms.canEditReports, true);
  assert.equal(perms.canDeleteReports, true);
  // Governance powers must stay off no matter what — a contractor's
  // link should never be able to mint more access or touch membership.
  assert.equal(perms.canShareDashboard, false);
  assert.equal(perms.canKickMembers, false);
  assert.equal(perms.canBanMembers, false);
  assert.equal(perms.canManageRoles, false);
  assert.equal(perms.canManageSettings, false);
});

test('a revoked share link grants no access at all, even to someone who already redeemed it', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'DEV' });
  await db.verifyUser({ discordId: 'guest3', discordUsername: 'Guest3' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest3' });
  assert.ok((await db.getEffectivePermissions(server.id, 'guest3'))?.canManageBugs, 'sanity check before revoking');

  await db.revokeShareLink({ serverId: server.id, actingDiscordId: 'owner1', shareLinkId: link.id });

  const perms = await db.getEffectivePermissions(server.id, 'guest3');
  assert.equal(perms, null, 'revoking must immediately invalidate existing redemptions, not just block new ones');
});

test('a custom role granted action permissions but not explicit canViewDashboard still gets dashboard access, not silently inert', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await db.verifyUser({ discordId: 'forgetful-owner-setup', discordUsername: 'Forgetful' });
  // Deliberately omit canViewDashboard, like an owner forgetting to check that box
  const role = await db.createRole({
    serverId: server.id, actingDiscordId: 'owner1', name: 'ForgotView', rank: 20,
    permissions: { canManageBugs: true },
  });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'forgetful-owner-setup', roleId: role.id });

  const perms = await db.getEffectivePermissions(server.id, 'forgetful-owner-setup');
  assert.equal(perms.canViewDashboard, true, 'canManageBugs without explicit canViewDashboard should not be a dead grant');
  assert.equal(perms.canManageBugs, true);
});

test('Tester (no dashboard action permissions at all) still correctly has no view access — the implication only kicks in when some other power IS granted', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const perms = await db.getEffectivePermissions(server.id, 'tester1');
  assert.equal(perms.canViewDashboard, false);
});


test('Tester (no extra perms) is blocked from every report mutation, even calling the data layer directly', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const report = await db.createBugReport(server.id, 'tester1', { title: 'orig', description: 'd', priority: 'LOW', status: 'NEW' });

  await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } }));
  await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { title: 'hacked' } }));
  await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { retestMessageId: 'fake' } }));
  await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { archivedAt: new Date() } }));
  await assert.rejects(() => db.deleteBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id }));
  await assert.rejects(() => db.adjustPointsManually({ serverId: server.id, actingDiscordId: 'tester1', targetDiscordId: 'tester1', delta: 1000 }));
});

test('Dev (report perms, zero governance perms) is blocked from every governance action', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);

  await assert.rejects(() => db.grantRole({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', roleId: 'whatever' }));
  await assert.rejects(() => db.kickMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1' }));
  await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1' }));
  await assert.rejects(() => db.createShareLink({ serverId: server.id, actingDiscordId: 'dev1', accessLevel: 'VIEW' }));
  await assert.rejects(() => db.updateServerSettings({ serverId: server.id, actingDiscordId: 'dev1', retestChannelId: 'evil' }));
  await assert.rejects(() => db.createRole({ serverId: server.id, actingDiscordId: 'dev1', name: 'New', rank: 5 }));
});

test('updateServerSettings: updating one setting never touches the other', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);

  await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', retestChannelId: 'channel-1' });
  let updated = await db.getServerById(server.id);
  assert.equal(updated.retestChannelId, 'channel-1');
  assert.equal(updated.testerPingRoleId ?? null, null, 'should still be unset');

  await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', testerPingRoleId: 'role-1' });
  updated = await db.getServerById(server.id);
  assert.equal(updated.retestChannelId, 'channel-1', 'setting the role must not have wiped the previously-set channel');
  assert.equal(updated.testerPingRoleId, 'role-1');
});

test('Dev CAN manage reports, including archiving once the report reaches a terminal status', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  const report = await db.createBugReport(server.id, 'tester1', { title: 'orig', description: 'd', priority: 'LOW', status: 'NEW' });

  await assert.rejects(
    () => db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { archivedAt: new Date() } }),
    /Status must be/,
    'cannot archive a non-terminal-status report even with canArchive',
  );

  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } });
  const archived = await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { archivedAt: new Date() } });
  assert.ok(archived.archivedAt, 'archiving should succeed once status is terminal');
});
