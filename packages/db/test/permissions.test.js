const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

const DEV_ROLE = 'dev-discord-role';
const TESTER_ROLE = 'tester-discord-role';

async function setupServerWithDevAndTester(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });

  await db.setRolePermissions({
    serverId: server.id, actingDiscordId: 'owner1', discordRoleId: DEV_ROLE,
    permissions: { canSubmitBugs: true, canViewDashboard: true, canManageBugs: true, canPingTesters: true, canArchive: true, canEditReports: true, canDeleteReports: true },
  });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  return { server };
}

test('getEffectivePermissions: role shape carries every flag from the configured role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);

  await withDiscordRoles({ dev1: [DEV_ROLE] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'dev1');
    assert.equal(perms.source, 'role');
    assert.equal(perms.canManageBugs, true);
    assert.equal(perms.canManageRoles, false, 'Dev role here was not granted role management');
  });
});

test('getEffectivePermissions: returns null for someone with no configured role and no guest access', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await withDiscordRoles({ 'totally-unrelated-person': [] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'totally-unrelated-person');
    assert.equal(perms, null);
  });
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
  assert.equal(perms.canBanMembers, false);
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
  assert.equal(perms.canShareDashboard, false);
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

test('a role granted action permissions but not explicit canViewDashboard still gets dashboard access, not silently inert', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await db.verifyUser({ discordId: 'forgetful-owner-setup', discordUsername: 'Forgetful' });
  const FORGOT_VIEW_ROLE = 'forgot-view-role';
  // Deliberately omit canViewDashboard, like an owner forgetting to check that box
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: FORGOT_VIEW_ROLE, permissions: { canManageBugs: true } });

  await withDiscordRoles({ 'forgetful-owner-setup': [FORGOT_VIEW_ROLE] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'forgetful-owner-setup');
    assert.equal(perms.canViewDashboard, true, 'canManageBugs without explicit canViewDashboard should not be a dead grant');
    assert.equal(perms.canManageBugs, true);
  });
});

test('Tester (no dashboard action permissions at all) still correctly has no view access — the implication only kicks in when some other power IS granted', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'tester1');
    assert.equal(perms.canViewDashboard, false);
  });
});

test('Tester (no extra perms) is blocked from every report mutation, even calling the data layer directly', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 'orig', description: 'd', priority: 'LOW', status: 'NEW' });

    await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } }));
    await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { title: 'hacked' } }));
    await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { retestMessageId: 'fake' } }));
    await assert.rejects(() => db.updateBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id, requestedChanges: { archivedAt: new Date() } }));
    await assert.rejects(() => db.deleteBugReport({ serverId: server.id, actingDiscordId: 'tester1', bugReportId: report.id }));
    await assert.rejects(() => db.adjustPointsManually({ serverId: server.id, actingDiscordId: 'tester1', targetDiscordId: 'tester1', delta: 1000 }));
  });
});

test('Dev (report perms, zero governance perms) is blocked from every governance action', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await withDiscordRoles({ dev1: [DEV_ROLE], tester1: [TESTER_ROLE] }, async () => {
    await assert.rejects(() => db.setRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', discordRoleId: 'whatever', permissions: {} }));
    await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1' }));
    await assert.rejects(() => db.createShareLink({ serverId: server.id, actingDiscordId: 'dev1', accessLevel: 'VIEW' }));
    await assert.rejects(() => db.updateServerSettings({ serverId: server.id, actingDiscordId: 'dev1', retestChannelId: 'evil' }));
  });
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
  await withDiscordRoles({ dev1: [DEV_ROLE], tester1: [TESTER_ROLE] }, async () => {
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
});

test('status is locked while a report is archived, and unarchiving restores it', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await withDiscordRoles({ dev1: [DEV_ROLE], tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 'orig', description: 'd', priority: 'LOW', status: 'NEW' });
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } });
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { archivedAt: new Date() } });

    await assert.rejects(
      () => db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { status: 'NEW' } }),
      /locked while this report is archived/,
      'status cannot change while archived',
    );

    const unarchived = await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { archivedAt: null } });
    assert.equal(unarchived.archivedAt, null, 'unarchiving should succeed');

    const restatused = await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { status: 'NEW' } });
    assert.equal(restatused.status, 'NEW', 'status is editable again once unarchived');
  });
});

test('unarchiving works even if status somehow drifted to non-terminal while archived (pre-existing data, not reachable via the API anymore now that status is locked)', async () => {
  const { db, fakeClient } = loadDbWithFakePrisma();
  const { server } = await setupServerWithDevAndTester(db);
  await withDiscordRoles({ dev1: [DEV_ROLE], tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 'orig', description: 'd', priority: 'LOW', status: 'NEW' });
    // Force the edge case directly, bypassing updateBugReport's own rules,
    // to simulate data from before the status lock existed.
    fakeClient.bugReport.update({ where: { id: report.id }, data: { status: 'FIXED', archivedAt: new Date() } });
    fakeClient.bugReport.update({ where: { id: report.id }, data: { status: 'NEW' } });

    const unarchived = await db.updateBugReport({ serverId: server.id, actingDiscordId: 'dev1', bugReportId: report.id, requestedChanges: { archivedAt: null } });
    assert.equal(unarchived.archivedAt, null, 'unarchiving must never be blocked by the terminal-status check — that check is for archiving, not for clearing archivedAt');
  });
});
