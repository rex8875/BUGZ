const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  return { server };
}

test('an owner can set the announce channel, independently of the retest channel', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);

  await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', retestChannelId: 'retest-chan' });
  const updated = await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', announceChannelId: 'announce-chan' });

  assert.equal(updated.announceChannelId, 'announce-chan');
  assert.equal(updated.retestChannelId, 'retest-chan', 'setting the announce channel must not clobber the retest channel');
});

test('a Tester (no canManageSettings) cannot set the announce channel', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);

  await assert.rejects(
    () => db.updateServerSettings({ serverId: server.id, actingDiscordId: 'tester1', announceChannelId: 'announce-chan' }),
    /not permitted/i,
  );
});
