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

test('marking a report NOT_A_BUG deducts a point, same as DUPLICATE', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    assert.equal(await points(db, server, 'tester1'), 1);

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'NOT_A_BUG' } });
    assert.equal(await points(db, server, 'tester1'), 0);
  });
});

test('moving a report back off NOT_A_BUG refunds the point', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'NOT_A_BUG' } });
    assert.equal(await points(db, server, 'tester1'), 0);

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'NEW' } });
    assert.equal(await points(db, server, 'tester1'), 1, 'the point should come back');
  });
});

test('moving directly between DUPLICATE and NOT_A_BUG never double-deducts or double-refunds', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    assert.equal(await points(db, server, 'tester1'), 1);

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'DUPLICATE' } });
    assert.equal(await points(db, server, 'tester1'), 0, 'deducted once for DUPLICATE');

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'NOT_A_BUG' } });
    assert.equal(await points(db, server, 'tester1'), 0, 'switching straight to NOT_A_BUG must not deduct a second point');

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'DUPLICATE' } });
    assert.equal(await points(db, server, 'tester1'), 0, 'switching back to DUPLICATE must not deduct yet another point');

    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } });
    assert.equal(await points(db, server, 'tester1'), 1, 'leaving the deducting statuses for good should refund exactly the one point that was ever taken');
  });
});

test('WONT_FIX does NOT deduct a point — only DUPLICATE and NOT_A_BUG do', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'WONT_FIX' } });
    assert.equal(await points(db, server, 'tester1'), 1, "Won't fix means it's a real, valid finding — the point should stay");
  });
});

test('NOT_A_BUG also deducts from the weekly leaderboard, not just the all-time one', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
    await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'NOT_A_BUG' } });

    const { scores } = await db.getWeeklyLeaderboard(server.id);
    const entry = scores.find((s) => s.user.discordId === 'tester1');
    assert.equal(entry ? entry.points : 0, 0);
  });
});
