const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  return { server };
}

test('deleteExpiredArchivedReports removes only reports archived more than 15 days ago', async () => {
  const { db, fakeClient } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);

  const old = fakeClient.bugReport.create({
    data: { serverId: server.id, reporterId: 'owner1', title: 'old, should be deleted', status: 'FIXED', archivedAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000) },
  });
  const recent = fakeClient.bugReport.create({
    data: { serverId: server.id, reporterId: 'owner1', title: 'recent, should survive', status: 'FIXED', archivedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
  });
  const neverArchived = fakeClient.bugReport.create({
    data: { serverId: server.id, reporterId: 'owner1', title: 'never archived', status: 'NEW' },
  });

  const deletedCount = await db.deleteExpiredArchivedReports();
  assert.equal(deletedCount, 1);

  assert.equal(fakeClient.bugReport.findUnique({ where: { id: old.id } }), null, 'old archived report should be gone');
  assert.ok(fakeClient.bugReport.findUnique({ where: { id: recent.id } }), 'recently archived report must survive');
  assert.ok(fakeClient.bugReport.findUnique({ where: { id: neverArchived.id } }), 'never-archived report must survive regardless of age');
});

test('deleteExpiredArchivedReports never touches a different server\'s reports differently — it is a global sweep by design, scoped only by archive age', async () => {
  const { db, fakeClient } = loadDbWithFakePrisma();
  const { server: serverA } = await setupServer(db);
  const serverB = await db.createServerOnJoin({ discordServerId: 'gB', name: 'B', ownerDiscordId: 'ownerB' });

  fakeClient.bugReport.create({ data: { serverId: serverA.id, reporterId: 'owner1', title: 'a-old', status: 'FIXED', archivedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) } });
  fakeClient.bugReport.create({ data: { serverId: serverB.id, reporterId: 'ownerB', title: 'b-old', status: 'FIXED', archivedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) } });

  const deletedCount = await db.deleteExpiredArchivedReports();
  assert.equal(deletedCount, 2, 'the sweep should catch expired reports across every server');
});

test('getReportSummary counts active reports by status and excludes archived ones', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.createBugReport(server.id, 'owner1', { title: 'a', description: 'd', priority: 'LOW', status: 'NEW' });
  await db.createBugReport(server.id, 'owner1', { title: 'b', description: 'd', priority: 'LOW', status: 'NEW' });
  const fixedOne = await db.createBugReport(server.id, 'owner1', { title: 'c', description: 'd', priority: 'LOW', status: 'FIXED' });
  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: fixedOne.id, requestedChanges: { archivedAt: new Date() } });

  const summary = await db.getReportSummary(server.id);
  assert.equal(summary.NEW, 2);
  assert.equal(summary.FIXED, undefined, 'the archived Fixed report should not be counted at all');
  assert.equal(summary.total, 2);
});

test('searchBugReports filters by keyword and by priority, excludes archived reports, and is case-insensitive', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.createBugReport(server.id, 'owner1', { title: 'Floor breaks near spawn', description: 'd', priority: 'CRITICAL', status: 'NEW' });
  await db.createBugReport(server.id, 'owner1', { title: 'Wall clips in raid', description: 'd', priority: 'LOW', status: 'NEW' });
  const toArchive = await db.createBugReport(server.id, 'owner1', { title: 'Floor texture missing', description: 'd', priority: 'CRITICAL', status: 'FIXED' });
  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: toArchive.id, requestedChanges: { archivedAt: new Date() } });

  const byKeyword = await db.searchBugReports(server.id, { search: 'FLOOR' });
  assert.equal(byKeyword.length, 1, 'should match case-insensitively and exclude the archived "Floor texture" report');
  assert.equal(byKeyword[0].title, 'Floor breaks near spawn');

  const byPriority = await db.searchBugReports(server.id, { priority: 'LOW' });
  assert.equal(byPriority.length, 1);
  assert.equal(byPriority[0].title, 'Wall clips in raid');
});

test('a share link can be redeemed by multiple different people, and listShareLinks reports all of them', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW', label: 'two contractors' });
  await db.verifyUser({ discordId: 'guestA', discordUsername: 'GuestA' });
  await db.verifyUser({ discordId: 'guestB', discordUsername: 'GuestB' });

  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guestA' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guestB' });

  const links = await db.listShareLinks(server.id);
  const thisLink = links.find((l) => l.id === link.id);
  assert.equal(thisLink.guestAccess.length, 2);
});

test('redeeming the same share link twice for the same person does not create a duplicate grant', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW' });
  await db.verifyUser({ discordId: 'guest1', discordUsername: 'Guest' });

  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' });
  await db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' }); // e.g. they click the link twice

  const links = await db.listShareLinks(server.id);
  const thisLink = links.find((l) => l.id === link.id);
  assert.equal(thisLink.guestAccess.length, 1, 'redeeming twice must not double up the grant');
});

test('redeeming requires verification first', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW' });
  await assert.rejects(
    () => db.redeemShareLink({ shareLinkId: link.id, discordId: 'never-verified' }),
    /verify/i,
  );
});

test('redeeming a nonexistent or already-revoked link fails clearly', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.verifyUser({ discordId: 'guest1', discordUsername: 'Guest' });

  await assert.rejects(() => db.redeemShareLink({ shareLinkId: 'not-a-real-id', discordId: 'guest1' }), /invalid or has been revoked/);

  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW' });
  await db.revokeShareLink({ serverId: server.id, actingDiscordId: 'owner1', shareLinkId: link.id });
  await assert.rejects(() => db.redeemShareLink({ shareLinkId: link.id, discordId: 'guest1' }), /invalid or has been revoked/);
});
