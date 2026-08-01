const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

async function setupServerWithReports(db, count = 12) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    for (let i = 0; i < count; i++) {
      await db.createBugReport(server.id, 'tester1', {
        title: `Bug ${i}`, description: `desc ${i} basement`, priority: 'LOW', device: 'PC',
        evidenceLink: 'https://x.com', f9Link: 'https://x.com',
      });
    }
  });
  return server;
}

test('queryBugReports paginates correctly (page size, total pages, total count)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 12);

  const page1 = await db.queryBugReports(server.id, { page: 1, pageSize: 5 });
  assert.equal(page1.reports.length, 5);
  assert.equal(page1.totalCount, 12);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.page, 1);

  const page3 = await db.queryBugReports(server.id, { page: 3, pageSize: 5 });
  assert.equal(page3.reports.length, 2, 'last page should have the remainder');

  const outOfRange = await db.queryBugReports(server.id, { page: 99, pageSize: 5 });
  assert.equal(outOfRange.page, 3, 'an out-of-range page should clamp to the last real page');
});

test('queryBugReports excludes archived reports by default ("only non-archived, non-deleted")', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 3);
  const all = await db.queryBugReports(server.id, { pageSize: 10 });

  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: all.reports[0].id, requestedChanges: { status: 'FIXED' } });
  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: all.reports[0].id, requestedChanges: { archivedAt: new Date() } });

  const active = await db.queryBugReports(server.id, { pageSize: 10 });
  assert.equal(active.totalCount, 2);

  const archivedOnly = await db.queryBugReports(server.id, { archived: true, pageSize: 10 });
  assert.equal(archivedOnly.totalCount, 1);
});

test('queryBugReports search matches title OR description (case-insensitive)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 5); // descriptions all contain "basement"
  const result = await db.queryBugReports(server.id, { search: 'BASEMENT', pageSize: 10 });
  assert.equal(result.totalCount, 5, 'search should match description text case-insensitively');

  const noMatch = await db.queryBugReports(server.id, { search: 'nonexistentword', pageSize: 10 });
  assert.equal(noMatch.totalCount, 0);
});

test('queryBugReports filters by exact reporterDiscordId (for /my-bugs and /bugs-by)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 3);
  await db.verifyUser({ discordId: 'tester2', discordUsername: 'Tester2' });
  await withDiscordRoles({ tester2: [TESTER_ROLE] }, async () => {
    await db.createBugReport(server.id, 'tester2', { title: 'Someone else bug', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com' });
  });

  const tester1Reports = await db.queryBugReports(server.id, { reporterDiscordId: 'tester1', pageSize: 10 });
  assert.equal(tester1Reports.totalCount, 3);

  const tester2Reports = await db.queryBugReports(server.id, { reporterDiscordId: 'tester2', pageSize: 10 });
  assert.equal(tester2Reports.totalCount, 1);
});

test('queryBugReports date filters (before/on/after) work on createdAt', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });

  const report = await db.createBugReport(server.id, 'owner1', {
    title: 'Dated bug', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com',
  });

  const onSameDay = await db.queryBugReports(server.id, { on: new Date(report.createdAt).toISOString().slice(0, 10), pageSize: 10 });
  assert.equal(onSameDay.totalCount, 1, "'on' today's date should match a report created today");

  const beforeYesterday = await db.queryBugReports(server.id, { before: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10), pageSize: 10 });
  assert.equal(beforeYesterday.totalCount, 0, "'before' yesterday should exclude a report created today");

  const afterYesterday = await db.queryBugReports(server.id, { after: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10), pageSize: 10 });
  assert.equal(afterYesterday.totalCount, 1, "'after' yesterday should include a report created today");
});

test('queryBugReports still shows reports from a reporter who has since left the server (data preserved)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 2);
  // Leaving no longer touches any internal state — permissions are live
  // and reports are attached to the User row, not a Membership. The
  // only explicit cleanup on leave is leaderboard-hiding.
  await db.hideLeaverFromLeaderboard(server.id, 'tester1');

  const result = await db.queryBugReports(server.id, { pageSize: 10 });
  assert.equal(result.totalCount, 2, 'leaving the server must not remove their reports from list views');
});

test('queryBugReports never crashes on malformed or malicious date tokens, and simply does not filter on them', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 1);
  const malformed = ['notadate', '2024-13-45', '', 'DROP TABLE reports', '../../etc/passwd', '9999-99-99'];
  for (const bad of malformed) {
    const result = await db.queryBugReports(server.id, { on: bad, pageSize: 10 });
    assert.equal(result.totalCount, 1, `on:"${bad}" should not crash and should not filter anything out`);
  }
});

test('getBugReportByNumber finds a report by its per-server sequential number', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 3);
  const found = await db.getBugReportByNumber(server.id, 2);
  assert.equal(found.bugNumber, 2);
  assert.equal(found.title, 'Bug 1'); // 0-indexed loop, so bugNumber 2 is "Bug 1"
});

test('countBugReportsByReporter counts all of a person\'s reports, including archived', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithReports(db, 3);
  const all = await db.queryBugReports(server.id, { pageSize: 10 });
  const count0 = all.reports[0].id;
  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: count0, requestedChanges: { status: 'FIXED' } });
  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: count0, requestedChanges: { archivedAt: new Date() } });

  const count = await db.countBugReportsByReporter(server.id, 'tester1');
  assert.equal(count, 3, 'archived reports still count toward the Xth-bug total');
});
