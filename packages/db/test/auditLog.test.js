const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  return { server };
}

test('governance actions are recorded in the audit log with the correct actor and action type', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');

  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', reason: 'spam' });
  await db.unbanMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  const link = await db.createShareLink({ serverId: server.id, actingDiscordId: 'owner1', accessLevel: 'VIEW' });
  await db.revokeShareLink({ serverId: server.id, actingDiscordId: 'owner1', shareLinkId: link.id });

  const log = await db.listAuditLog(server.id);
  const actions = log.map((e) => e.action);

  assert.ok(actions.includes('ROLE_GRANTED'));
  assert.ok(actions.includes('MEMBER_BANNED'));
  assert.ok(actions.includes('MEMBER_UNBANNED'));
  assert.ok(actions.includes('SHARE_LINK_CREATED'));
  assert.ok(actions.includes('SHARE_LINK_REVOKED'));
  assert.ok(log.every((e) => e.actorDiscordId === 'owner1'), 'every entry should record who actually did it');
});

test('audit log entries are scoped per server, and most-recent-first', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server: serverA } = await setupServer(db);
  const serverB = await db.createServerOnJoin({ discordServerId: 'gB', name: 'B', ownerDiscordId: 'ownerB' });
  await db.verifyUser({ discordId: 'ownerB', discordUsername: 'OwnerB' });

  await db.createShareLink({ serverId: serverA.id, actingDiscordId: 'owner1', accessLevel: 'VIEW', label: 'first' });
  await db.createShareLink({ serverId: serverB.id, actingDiscordId: 'ownerB', accessLevel: 'VIEW', label: 'second' });
  await db.createShareLink({ serverId: serverA.id, actingDiscordId: 'owner1', accessLevel: 'VIEW', label: 'third' });

  const logA = await db.listAuditLog(serverA.id);
  assert.equal(logA.length, 2, 'server B\'s action must not appear in server A\'s log');
  assert.equal(JSON.parse(logA[0].details).label, 'third', 'most recent entry should come first');
});

test('routine bug-report status/priority edits are deliberately NOT logged — only governance actions are', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });

  const report = await db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' });
  await db.updateBugReport({ serverId: server.id, actingDiscordId: 'owner1', bugReportId: report.id, requestedChanges: { status: 'FIXED' } });

  const log = await db.listAuditLog(server.id);
  assert.equal(log.filter((e) => e.action.startsWith('REPORT_')).length, 0);
});
