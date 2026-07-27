const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

function withMockedDiscordFetch(memberResponses, fn) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    const status = memberResponses[calls.length - 1]?.status ?? 200;
    const body = memberResponses[calls.length - 1]?.body ?? { roles: [] };
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return fn(calls).finally(() => { global.fetch = realFetch; });
}

async function setupServerWithAdminRole(db, { adminRoleId = 'admin-role-123' } = {}) {
  const server = await db.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'randomPerson', discordUsername: 'Random' });
  await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', adminRoleId });
  return server;
}

test('memberHasDiscordRole returns true when the live Discord response includes the role', async () => {
  const { db } = loadDbWithFakePrisma();
  await withMockedDiscordFetch([{ status: 200, body: { roles: ['role-a', 'admin-role-123', 'role-b'] } }], async (calls) => {
    const result = await db.memberHasDiscordRole('guild-1', 'user-1', 'admin-role-123');
    assert.equal(result, true);
    assert.match(calls[0], /\/guilds\/guild-1\/members\/user-1$/);
  });
});

test('memberHasDiscordRole returns false when the role is not in their live role list', async () => {
  const { db } = loadDbWithFakePrisma();
  await withMockedDiscordFetch([{ status: 200, body: { roles: ['role-a', 'role-b'] } }], async () => {
    const result = await db.memberHasDiscordRole('guild-1', 'user-1', 'admin-role-123');
    assert.equal(result, false);
  });
});

test('memberHasDiscordRole fails closed (false, not a crash) on a 404 — e.g. they left the server', async () => {
  const { db } = loadDbWithFakePrisma();
  await withMockedDiscordFetch([{ status: 404, body: {} }], async () => {
    const result = await db.memberHasDiscordRole('guild-1', 'user-1', 'admin-role-123');
    assert.equal(result, false);
  });
});

test('memberHasDiscordRole fails closed on a network error, never throws', async () => {
  const { db } = loadDbWithFakePrisma();
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await db.memberHasDiscordRole('guild-1', 'user-1', 'admin-role-123');
    assert.equal(result, false);
  } finally {
    global.fetch = realFetch;
  }
});

test('a person with ZERO internal membership, holding the admin role, gets FULL permissions', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithAdminRole(db);
  await withMockedDiscordFetch([{ status: 200, body: { roles: ['admin-role-123'] } }], async () => {
    const perms = await db.getEffectivePermissions(server.id, 'randomPerson');
    assert.equal(perms.canManageSettings, true);
    assert.equal(perms.canManageBugs, true);
    assert.equal(perms.canBanMembers, true);
    assert.equal(perms.source, 'admin-role');
  });
});

test('a person with a LIMITED internal role (Tester) who ALSO holds the admin role gets upgraded to FULL permissions', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithAdminRole(db);
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'randomPerson', roleId: testerRole.id });

  await withMockedDiscordFetch([{ status: 200, body: { roles: ['admin-role-123'] } }], async () => {
    const perms = await db.getEffectivePermissions(server.id, 'randomPerson');
    assert.equal(perms.canManageSettings, true, 'the admin role should override the more limited Tester internal role, not be capped by it');
    assert.equal(perms.canManageBugs, true);
  });
});

test('a person WITHOUT the admin role, and with no internal membership, still gets null (no accidental grant)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithAdminRole(db);
  await withMockedDiscordFetch([{ status: 200, body: { roles: ['some-other-role'] } }], async () => {
    const perms = await db.getEffectivePermissions(server.id, 'randomPerson');
    assert.equal(perms, null);
  });
});

test('a Tester who does NOT hold the admin role keeps their normal limited Tester permissions', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithAdminRole(db);
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'randomPerson', roleId: testerRole.id });

  await withMockedDiscordFetch([{ status: 200, body: { roles: ['unrelated-role'] } }], async () => {
    const perms = await db.getEffectivePermissions(server.id, 'randomPerson');
    assert.equal(perms.canManageSettings, false);
    assert.equal(perms.canSubmitBugs, true);
  });
});

test('someone already fully privileged internally (Owner) never triggers a live Discord API call at all', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithAdminRole(db);
  await withMockedDiscordFetch([], async (calls) => {
    const perms = await db.getEffectivePermissions(server.id, 'owner1');
    assert.equal(perms.canManageSettings, true);
    assert.equal(calls.length, 0, 'no Discord API call should have been made — the internal Owner permissions already suffice');
  });
});

test('a server with NO admin role configured never attempts a live Discord API call', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'guild-2', name: 'NoAdminRole', ownerDiscordId: 'owner2' });
  await db.verifyUser({ discordId: 'owner2', discordUsername: 'Owner2' });
  await db.verifyUser({ discordId: 'nobody', discordUsername: 'Nobody' });
  await withMockedDiscordFetch([], async (calls) => {
    const perms = await db.getEffectivePermissions(server.id, 'nobody');
    assert.equal(perms, null);
    assert.equal(calls.length, 0);
  });
});

test('the admin role has no effect at all on a DIFFERENT server, even with the identical role id (must not leak)', async () => {
  const { db } = loadDbWithFakePrisma();
  await setupServerWithAdminRole(db, { adminRoleId: 'shared-role-id' });
  const otherServer = await db.createServerOnJoin({ discordServerId: 'guild-other', name: 'Other', ownerDiscordId: 'ownerOther' });
  await db.verifyUser({ discordId: 'ownerOther', discordUsername: 'OwnerOther' });
  await db.verifyUser({ discordId: 'someone', discordUsername: 'Someone' });

  await withMockedDiscordFetch([], async (calls) => {
    // otherServer never configured an adminRoleId, so this must not
    // even attempt a live check, regardless of what role ids exist
    // elsewhere.
    const perms = await db.getEffectivePermissions(otherServer.id, 'someone');
    assert.equal(perms, null);
    assert.equal(calls.length, 0);
  });
});

test('a Discord API failure while checking the admin role fails closed, falling back to whatever internal permissions exist (or none)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServerWithAdminRole(db);
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('Discord is down'); };
  try {
    const perms = await db.getEffectivePermissions(server.id, 'randomPerson');
    assert.equal(perms, null, 'a Discord outage must never accidentally grant access — fails closed to no permissions here');
  } finally {
    global.fetch = realFetch;
  }
});

test('updateServerSettings can set adminRoleId independently of the other settings fields', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'guild-3', name: 'Test3', ownerDiscordId: 'owner3' });
  await db.verifyUser({ discordId: 'owner3', discordUsername: 'Owner3' });
  await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner3', retestChannelId: 'chan-1' });
  const updated = await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner3', adminRoleId: 'role-xyz' });
  assert.equal(updated.adminRoleId, 'role-xyz');
  assert.equal(updated.retestChannelId, 'chan-1', 'setting adminRoleId must not clobber retestChannelId');
});

test('end-to-end: the admin role bypasses checkCommandAccess even for a command restricted to a totally different role', async () => {
  const { db } = loadDbWithFakePrisma();
  const { checkCommandAccess } = require('../../../apps/bot/src/lib/commandAccess.js');

  const server = await db.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.updateServerSettings({ serverId: server.id, actingDiscordId: 'owner1', adminRoleId: 'admin-role-999' });
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['some-other-role'] });

  await withMockedDiscordFetch([{ status: 200, body: { roles: ['admin-role-999'] } }], async () => {
    const interaction = {
      guildId: 'guild-1',
      user: { id: 'adminRoleHolder' },
      member: { permissions: { has: () => false }, roles: { cache: new Map([['admin-role-999', { id: 'admin-role-999' }]]) } },
    };
    const result = await checkCommandAccess(interaction, 'reset-score');
    assert.equal(result.allowed, true, 'the admin role should grant full access, not just access to commands allow-listing that exact role');
  });
});
