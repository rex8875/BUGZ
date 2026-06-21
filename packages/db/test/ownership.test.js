const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

test('createServerOnJoin seeds Owner (full perms) and Tester (minimal) roles', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  const roles = await db.listRoles(server.id);

  const owner = roles.find((r) => r.name === 'Owner');
  const tester = roles.find((r) => r.name === 'Tester');

  assert.ok(owner.canManageRoles && owner.canManageSettings && owner.canBanMembers && owner.canKickMembers && owner.canShareDashboard);
  assert.equal(tester.canSubmitBugs, true);
  assert.equal(tester.canViewDashboard, false, 'testers stay Discord-only by design, not dashboard-side');
  assert.equal(tester.canManageBugs, false);
});

test('re-joining an existing server updates the name but never silently changes the recorded owner', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.createServerOnJoin({ discordServerId: 'g1', name: 'Original Name', ownerDiscordId: 'owner1' });
  const updated = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Renamed', ownerDiscordId: 'someone-else' });

  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.ownerDiscordId, 'owner1', 'ownership must stay sticky even if the bot is re-invited by someone else');
});

test('verifying auto-claims Owner membership if you are the recorded owner of an unclaimed server', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });

  await db.verifyUser({ discordId: 'owner1', discordUsername: 'OwnerName' });

  const membership = await db.getMembership(server.id, 'owner1');
  assert.equal(membership.role.name, 'Owner');
});

test('verifying does NOT grant Owner to someone who is not the recorded owner', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });

  await db.verifyUser({ discordId: 'rando', discordUsername: 'Rando' });
  const server = await db.getServerByDiscordId('g1');
  const membership = await db.getMembership(server.id, 'rando');
  assert.equal(membership, null);
});

test('only the current owner can transfer ownership', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });

  await assert.rejects(
    () => db.transferOwnership({ serverId: server.id, actingDiscordId: 'not-the-owner', newOwnerDiscordId: 'newowner' }),
    /Only the current owner/,
  );
});

test('cannot transfer ownership to someone who has not verified', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });

  await assert.rejects(
    () => db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'unverified-person' }),
    /has not verified/,
  );
});

test('successful transfer updates ownerDiscordId and grants the new owner the Owner role', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });

  await db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'newowner' });

  const updatedServer = await db.getServerById(server.id);
  assert.equal(updatedServer.ownerDiscordId, 'newowner');

  const newMembership = await db.getMembership(server.id, 'newowner');
  assert.equal(newMembership.role.name, 'Owner');
});

test('after transfer, the previous owner can no longer transfer ownership again', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });
  await db.verifyUser({ discordId: 'thirdparty', discordUsername: 'Third' });

  await db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'newowner' });

  await assert.rejects(
    () => db.transferOwnership({ serverId: server.id, actingDiscordId: 'owner1', newOwnerDiscordId: 'thirdparty' }),
    /Only the current owner/,
  );
});
