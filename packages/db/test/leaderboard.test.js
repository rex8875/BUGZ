const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

async function setupServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
  return { server };
}

async function points(db, server, discordId) {
  const board = await db.getLeaderboard(server.id);
  const entry = board.find((s) => s.user.discordId === discordId);
  return entry ? entry.points : 0;
}

test('submitting a bug awards exactly one point', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    assert.equal(await points(db, server, 'tester1'), 1);
  });
});

test('marking a report DUPLICATE deducts the point; un-duplicating refunds it; re-duplicating deducts again', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    assert.equal(await points(db, server, 'tester1'), 1);

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'DUPLICATE' } });
    assert.equal(await points(db, server, 'tester1'), 0);

    // An unrelated field change while still DUPLICATE must not double-deduct
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { priority: 'HIGH' } });
    assert.equal(await points(db, server, 'tester1'), 0);

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } });
    assert.equal(await points(db, server, 'tester1'), 1, 'un-duplicating should refund the point');

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'DUPLICATE' } });
    assert.equal(await points(db, server, 'tester1'), 0, 're-marking duplicate should deduct again, not go negative or skip');
  });
});

test('weekly score is bucketed by the report\'s original creation week, even when corrected much later', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const oldWeekDate = new Date('2026-06-10T12:00:00Z'); // a Wednesday
    const report = await db.createBugReport(server.id, 'tester1', {
      title: 'old bug', description: 'd', priority: 'LOW', status: 'NEW', createdAt: oldWeekDate,
    });

    const oldWeekStart = db.getWeekStart(oldWeekDate);
    let weekly = await db.getWeeklyLeaderboard(server.id, { weekStart: oldWeekStart });
    assert.equal(weekly.scores.find((s) => s.user.discordId === 'tester1').points, 1);

    // Much later, marked duplicate — the deduction must land on the OLD week, not "now"
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'DUPLICATE' } });

    weekly = await db.getWeeklyLeaderboard(server.id, { weekStart: oldWeekStart });
    const oldWeekEntry = weekly.scores.find((s) => s.user.discordId === 'tester1');
    assert.equal(oldWeekEntry ? oldWeekEntry.points : 0, 0, 'the original week\'s score must be corrected, not left stale');

    const thisWeek = await db.getWeeklyLeaderboard(server.id); // defaults to current week
    assert.ok(
      !thisWeek.scores.some((s) => s.user.discordId === 'tester1' && s.points < 0),
      'the current week must not have been touched by a correction belonging to a past week',
    );
  });
});

test('adjustPointsManually requires canManageBugs and is independent of the automatic duplicate logic', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });

    await assert.rejects(
      () => db.adjustPointsManually({ serverId: server.id, actingDiscordId: 'tester1', targetDiscordId: 'tester1', delta: 5 }),
      /Not permitted/,
    );

    await db.adjustPointsManually({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', delta: 2 });
    assert.equal(await points(db, server, 'tester1'), 3);

    await db.adjustPointsManually({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', delta: -1 });
    assert.equal(await points(db, server, 'tester1'), 2);
  });
});
