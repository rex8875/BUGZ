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

test('a command with no configured override returns an empty array (fallback to internal permissions)', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const override = await db.getCommandRoleOverride(server.id, 'reset-score');
  assert.deepEqual(override, []);
});

test('an owner can set which Discord roles are allowed to use a command', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);

  const result = await db.setCommandPermissions({
    serverId: server.id,
    actingDiscordId: 'owner1',
    commandName: 'reset-score',
    discordRoleIds: ['discord-role-qa-lead', 'discord-role-mod'],
  });

  assert.deepEqual(result.sort(), ['discord-role-mod', 'discord-role-qa-lead']);
  const override = await db.getCommandRoleOverride(server.id, 'reset-score');
  assert.deepEqual(override.sort(), ['discord-role-mod', 'discord-role-qa-lead']);
});

test('setting an override for one command does not affect another command', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-a'] });
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'take-role', discordRoleIds: ['role-b'] });

  assert.deepEqual(await db.getCommandRoleOverride(server.id, 'reset-score'), ['role-a']);
  assert.deepEqual(await db.getCommandRoleOverride(server.id, 'take-role'), ['role-b']);
});

test('re-setting a command with an empty array clears its override entirely (back to default)', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-a'] });
  assert.equal((await db.getCommandRoleOverride(server.id, 'reset-score')).length, 1);

  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: [] });
  assert.deepEqual(await db.getCommandRoleOverride(server.id, 'reset-score'), []);
});

test('re-setting a command replaces the old list entirely, not merges with it', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-a', 'role-b'] });
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-c'] });

  assert.deepEqual(await db.getCommandRoleOverride(server.id, 'reset-score'), ['role-c']);
});

test('submitting the same Discord role id more than once does not crash — duplicates are deduped', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const result = await db.setCommandPermissions({
    serverId: server.id,
    actingDiscordId: 'owner1',
    commandName: 'reset-score',
    discordRoleIds: ['role-a', 'role-a', 'role-a', 'role-b'],
  });
  assert.deepEqual(result.sort(), ['role-a', 'role-b']);
});

test('empty-string, null, and undefined entries in discordRoleIds are filtered out rather than stored or crashing', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const result = await db.setCommandPermissions({
    serverId: server.id,
    actingDiscordId: 'owner1',
    commandName: 'reset-score',
    discordRoleIds: ['', 'role-b', null, undefined],
  });
  assert.deepEqual(result, ['role-b']);
});

test('re-saving the exact same override twice in a row is idempotent, not an error', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'bug', discordRoleIds: ['role-z'] });
  const second = await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'bug', discordRoleIds: ['role-z'] });
  assert.deepEqual(second, ['role-z']);
});

test('a Tester (no canManageSettings) cannot configure command permissions', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await assert.rejects(
      () => db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'tester1', commandName: 'reset-score', discordRoleIds: ['role-a'] }),
      /not permitted/i,
    );
  });
});

test('listCommandPermissions groups all configured overrides by command name', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-a'] });
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'take-role', discordRoleIds: ['role-b', 'role-c'] });

  const all = await db.listCommandPermissions(server.id);
  assert.deepEqual(all['reset-score'], ['role-a']);
  assert.deepEqual(all['take-role'].sort(), ['role-b', 'role-c']);
  assert.equal(all['give-role'], undefined, 'a command with no override should not appear in the grouped result at all');
});

test('overrides are scoped per server — the same command in a different server is unaffected', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server: serverA } = await setupServer(db);
  const serverB = await db.createServerOnJoin({ discordServerId: 'g2', name: 'Test2', ownerDiscordId: 'owner2' });
  await db.verifyUser({ discordId: 'owner2', discordUsername: 'Owner2' });

  await db.setCommandPermissions({ serverId: serverA.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-a'] });

  assert.deepEqual(await db.getCommandRoleOverride(serverA.id, 'reset-score'), ['role-a']);
  assert.deepEqual(await db.getCommandRoleOverride(serverB.id, 'reset-score'), [], "server B's override for the same command name must be independent");
});
