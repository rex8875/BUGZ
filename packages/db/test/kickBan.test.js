const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

// "Kick" doesn't exist anymore — there's nothing internal left to
// remove (permissions are checked live against Discord, not granted).
// Ban is the one moderation action left: an absolute app-level block,
// independent of whatever Discord roles someone holds. Rank-safety for
// ban now derives from Discord's own live role position ordering.
const DEV_ROLE = 'dev-role';
const PEER_ROLE = 'peer-role'; // same live position as DEV_ROLE — a peer, not a subordinate
const TESTER_ROLE = 'tester-role';

async function setupTieredServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });
  await db.verifyUser({ discordId: 'peer1', discordUsername: 'Peer' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });

  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: DEV_ROLE, permissions: { canBanMembers: true, canViewDashboard: true } });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: PEER_ROLE, permissions: {} });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  return { server };
}

// Position 50 for dev1/peer1 (same tier), 10 for tester1 (junior).
function tieredRolePositions(mock) {
  mock.setRolePosition(DEV_ROLE, 50);
  mock.setRolePosition(PEER_ROLE, 50);
  mock.setRolePosition(TESTER_ROLE, 10);
}

test('banMember requires canBanMembers', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.verifyUser({ discordId: 'norole', discordUsername: 'NoRole' });
  await withDiscordRoles({ norole: [], tester1: [TESTER_ROLE] }, async (mock) => {
    tieredRolePositions(mock);
    await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'norole', targetDiscordId: 'tester1' }), /Not permitted/);
  });
});

test('banMember cannot touch someone at or above your own live Discord role position', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE], peer1: [PEER_ROLE] }, async (mock) => {
    tieredRolePositions(mock);
    await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'peer1' }), /at or above your own role position/);
  });
});

test('banMember cannot ever target the server owner', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'owner1' }), /server owner/);
});

test('cannot ban yourself', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE] }, async (mock) => {
    tieredRolePositions(mock);
    await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'dev1' }), /yourself/);
  });
});

test('banMember against a genuinely lower-position target succeeds and blocks them', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ dev1: [DEV_ROLE], tester1: [TESTER_ROLE] }, async (mock) => {
    tieredRolePositions(mock);
    await db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', reason: 'spam' });
    assert.equal(await db.isBanned(server.id, 'tester1'), true);
  });
});

test('a ban is an absolute override on getEffectivePermissions, regardless of Discord roles held', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    assert.ok(await db.getEffectivePermissions(server.id, 'tester1'), 'sanity check before ban');
  });

  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });

  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    assert.equal(
      await db.getEffectivePermissions(server.id, 'tester1'),
      null,
      'banned must override even a currently-held, otherwise-valid role',
    );
  });
});

test('banned user cannot submit a bug report even though the role check would otherwise pass', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });

  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await assert.rejects(
      () => db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' }),
      /banned/,
    );
  });
});

test('unbanning restores access immediately if they still hold the role — nothing was ever taken away from the role itself, only blocked', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  await db.unbanMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });

  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'tester1');
    assert.ok(perms?.canSubmitBugs, 'access should resume immediately — the Tester role config was never touched by the ban/unban cycle');
  });
});

test('listBannedMembers reflects bans correctly, scoped per server', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', reason: 'spam' });

  const banned = await db.listBannedMembers(server.id);
  assert.equal(banned.length, 1);
  assert.equal(banned[0].discordId, 'tester1');
  assert.equal(banned[0].reason, 'spam');
});
