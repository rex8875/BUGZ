const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

async function setupServerWithScoredTester(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await db.createBugReport(server.id, 'tester1', {
      title: 'Bug', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com',
    });
  });
  return server;
}

test('leaving the server hides the leaderboard entry, but the score itself is preserved (not deleted, not zeroed)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithScoredTester(db);

  const before = await db.getLeaderboard(server.id);
  assert.equal(before.length, 1);
  const pointsBefore = before[0].points;

  await db.hideLeaverFromLeaderboard(server.id, 'tester1');

  const after = await db.getLeaderboard(server.id);
  assert.equal(after.length, 0, 'leaver must not appear on the leaderboard');

  // Score is stored, just not shown — verify directly.
  await db.restoreLeaderboardVisibilityOnRejoin(server.id, 'tester1');
  const restored = await db.getLeaderboard(server.id);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].points, pointsBefore, 'points must be unchanged by hide/restore, only visibility changes');
});

test('the weekly leaderboard also hides leavers and restores them the same way', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithScoredTester(db);

  const before = await db.getWeeklyLeaderboard(server.id);
  assert.equal(before.scores.length, 1);

  await db.hideLeaverFromLeaderboard(server.id, 'tester1');
  const hidden = await db.getWeeklyLeaderboard(server.id);
  assert.equal(hidden.scores.length, 0);

  await db.restoreLeaderboardVisibilityOnRejoin(server.id, 'tester1');
  const restored = await db.getWeeklyLeaderboard(server.id);
  assert.equal(restored.scores.length, 1);
});

test('rejoining (restoreLeaderboardVisibilityOnRejoin) automatically un-hides — no admin action required', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithScoredTester(db);
  await db.hideLeaverFromLeaderboard(server.id, 'tester1');
  assert.equal((await db.getLeaderboard(server.id)).length, 0);

  // Simulates the guildMemberAdd event firing on rejoin — no owner/perms
  // check here at all, matching "restore visibility automatically".
  await db.restoreLeaderboardVisibilityOnRejoin(server.id, 'tester1');
  assert.equal((await db.getLeaderboard(server.id)).length, 1);
});

test('an owner can manually reset a score to zero, independent of leave/rejoin state', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithScoredTester(db);

  await db.resetLeaderboardScore({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1' });
  const scores = await db.getLeaderboard(server.id);
  assert.equal(scores.length, 1, 'a reset score should still be visible (0 is a valid score, not hidden)');
  assert.equal(scores[0].points, 0);
});

test('a Tester (no canManageSettings) cannot reset someone\'s score', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithScoredTester(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await assert.rejects(
      () => db.resetLeaderboardScore({ serverId: server.id, actingDiscordId: 'tester1', targetDiscordId: 'tester1' }),
      /not permitted/i,
    );
  });
});

test('leaving with zero points (never reported anything) is a safe no-op, not an error', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'lurker1', discordUsername: 'Lurker' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  await assert.doesNotReject(() => db.hideLeaverFromLeaderboard(server.id, 'lurker1'));
});
