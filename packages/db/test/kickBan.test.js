const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupTieredServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });
  await db.verifyUser({ discordId: 'peer1', discordUsername: 'Peer' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });

  const devRole = await db.createRole({
    serverId: server.id, actingDiscordId: 'owner1', name: 'Dev', rank: 50,
    permissions: { canKickMembers: true, canBanMembers: true },
  });
  const peerRole = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'Peer', rank: 50, permissions: {} });
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');

  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'dev1', roleId: devRole.id });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'peer1', roleId: peerRole.id });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });

  return { server };
}

test('kickMember requires canKickMembers', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.verifyUser({ discordId: 'norole', discordUsername: 'NoRole' }); // has no membership, so definitely no canKickMembers
  await assert.rejects(() => db.kickMember({ serverId: server.id, actingDiscordId: 'norole', targetDiscordId: 'tester1' }), /Not permitted/);
});

test('kickMember cannot touch someone at or above your own rank', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await assert.rejects(() => db.kickMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'peer1' }), /at or above your own rank/);
});

test('kickMember cannot ever target the server owner', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await assert.rejects(() => db.kickMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'owner1' }), /server owner/);
});

test('kickMember succeeds against a genuinely lower-rank target and removes their membership', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.kickMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1' });
  const membership = await db.getMembership(server.id, 'tester1');
  assert.equal(membership, null);
});

test('kicking does NOT create a ban — the person can be re-promoted without unbanning', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.kickMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1' });

  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  const result = await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  assert.ok(result, 're-adding a kicked (not banned) person should work with no unban step');
});

test('banMember cannot touch someone at or above your own rank, or the owner', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'peer1' }), /at or above your own rank/);
  await assert.rejects(() => db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'owner1' }), /server owner/);
});

test('banMember removes membership AND blocks rejoining until unbanned', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'dev1', targetDiscordId: 'tester1', reason: 'spam' });

  assert.equal(await db.getMembership(server.id, 'tester1'), null);
  assert.equal(await db.isBanned(server.id, 'tester1'), true);

  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await assert.rejects(
    () => db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id }),
    /banned/,
  );

  await db.unbanMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  assert.equal(await db.isBanned(server.id, 'tester1'), false);
});

test('banned user cannot submit a bug report, even if somehow still holding a membership row', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  await assert.rejects(
    () => db.createBugReport(server.id, 'tester1', { title: 't', description: 'd', priority: 'LOW', status: 'NEW' }),
    /banned/,
  );
});

test('kicking a member immediately removes their dashboard access entirely (getEffectivePermissions returns null)', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.verifyUser({ discordId: 'devview', discordUsername: 'DevView' });
  const devRole = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'DevView', rank: 20, permissions: { canViewDashboard: true, canManageBugs: true } });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'devview', roleId: devRole.id });
  assert.ok(await db.getEffectivePermissions(server.id, 'devview'), 'sanity check before kick');

  await db.kickMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'devview' });

  assert.equal(await db.getEffectivePermissions(server.id, 'devview'), null, 'kicked member should have zero dashboard access, not just be missing from the member list');
});

test('banning a member immediately removes their dashboard access, and unbanning alone does NOT restore it (they need a role granted again first)', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.verifyUser({ discordId: 'devview2', discordUsername: 'DevView2' });
  const devRole = await db.createRole({ serverId: server.id, actingDiscordId: 'owner1', name: 'DevView2', rank: 20, permissions: { canViewDashboard: true } });
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'devview2', roleId: devRole.id });

  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'devview2' });
  assert.equal(await db.getEffectivePermissions(server.id, 'devview2'), null);

  await db.unbanMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'devview2' });
  assert.equal(
    await db.getEffectivePermissions(server.id, 'devview2'),
    null,
    'unbanning lifts the block on re-adding them, but does not by itself restore the roles that were stripped on ban',
  );

  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'devview2', roleId: devRole.id });
  assert.ok(await db.getEffectivePermissions(server.id, 'devview2'), 'access resumes once a role is actually granted again post-unban');
});

test('listBannedMembers and listMembers reflect kicks/bans correctly', async () => {

  const { db } = loadDbWithFakePrisma();
  const { server } = await setupTieredServer(db);
  await db.banMember({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', reason: 'spam' });

  const banned = await db.listBannedMembers(server.id);
  assert.equal(banned.length, 1);
  assert.equal(banned[0].discordId, 'tester1');
  assert.equal(banned[0].reason, 'spam');

  const members = await db.listMembers(server.id);
  assert.ok(!members.some((m) => m.user.discordId === 'tester1'), 'banned member should no longer appear in the member list');
});
