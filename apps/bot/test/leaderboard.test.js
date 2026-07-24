const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('../../../packages/db/test/helpers/loadDb');

function loadLeaderboardCommandWithFakeDb() {
  const { db } = loadDbWithFakePrisma();
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: db };

  const cmdPath = require.resolve('../src/commands/leaderboard.js');
  delete require.cache[cmdPath];
  const cmd = require(cmdPath);

  return { db, cmd, dbModulePath, originalDbCache };
}

async function seedServerWithScores(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'reporter1', discordUsername: 'TopScorer' });
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'reporter1', roleId: testerRole.id });
  await db.createBugReport(server.id, 'reporter1', {
    title: 'Bug', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com',
  });
  return server;
}

test('buildLeaderboardPayload builds an embed with scores and both scope buttons + a refresh button', async () => {
  const { db, cmd, dbModulePath, originalDbCache } = loadLeaderboardCommandWithFakeDb();
  try {
    const server = await seedServerWithScores(db);
    const payload = await cmd.buildLeaderboardPayload(server.id, 'all-time');

    assert.equal(payload.embeds.length, 1);
    assert.match(payload.embeds[0].data.title, /All-time/);
    assert.match(payload.embeds[0].data.description, /TopScorer/);

    const buttons = payload.components[0].components;
    assert.equal(buttons.length, 3, 'should have All-time, This week, and Refresh buttons');
    const customIds = buttons.map((b) => b.data.custom_id);
    assert.ok(customIds.includes('leaderboard_scope_all-time'));
    assert.ok(customIds.includes('leaderboard_scope_weekly'));
    assert.ok(customIds.includes('leaderboard_refresh_all-time'), 'refresh button should carry the current scope');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('the currently-active scope button is disabled so clicking it again is a no-op, not a re-fetch', async () => {
  const { db, cmd, dbModulePath, originalDbCache } = loadLeaderboardCommandWithFakeDb();
  try {
    const server = await seedServerWithScores(db);
    const payload = await cmd.buildLeaderboardPayload(server.id, 'weekly');
    const buttons = payload.components[0].components;
    const weeklyBtn = buttons.find((b) => b.data.custom_id === 'leaderboard_scope_weekly');
    const allTimeBtn = buttons.find((b) => b.data.custom_id === 'leaderboard_scope_all-time');
    assert.equal(weeklyBtn.data.disabled, true, 'the active scope should be disabled');
    assert.equal(allTimeBtn.data.disabled, false, 'the inactive scope should remain clickable');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('buildLeaderboardPayload handles an empty board without crashing', async () => {
  const { db, cmd, dbModulePath, originalDbCache } = loadLeaderboardCommandWithFakeDb();
  try {
    const server = await db.createServerOnJoin({ discordServerId: 'g-empty', name: 'Empty', ownerDiscordId: 'owner1' });
    const payload = await cmd.buildLeaderboardPayload(server.id, 'all-time');
    assert.match(payload.embeds[0].data.description, /No points on the board yet/);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
