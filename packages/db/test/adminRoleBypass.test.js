// Was previously about a dedicated Server.adminRoleId bypass field —
// that mechanism was superseded by the general RolePermission system
// (a role with every flag enabled achieves the same "full access"
// outcome through the one unified path; see /set-admin-role and
// permissions.test.js/roles.test.js). What's still uniquely worth
// testing here is getMemberDiscordRoleIds' own failure behavior, since
// EVERY non-owner permission check in the app now depends on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

function withMockedDiscordFetch(responses, fn) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const status = responses[calls.length - 1]?.status ?? 200;
    const body = responses[calls.length - 1]?.body ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return fn(calls).finally(() => { global.fetch = realFetch; });
}

test('getMemberDiscordRoleIds returns the live role array on success', async () => {
  const { db } = loadDbWithFakePrisma();
  await withMockedDiscordFetch([{ status: 200, body: { roles: ['role-a', 'role-b'] } }], async (calls) => {
    const result = await db.getMemberDiscordRoleIds('guild-1', 'user-1');
    assert.deepEqual(result, ['role-a', 'role-b']);
    assert.match(calls[0], /\/guilds\/guild-1\/members\/user-1$/);
  });
});

test('getMemberDiscordRoleIds returns null (not a crash, not an empty array) on a 404 — e.g. they left the server', async () => {
  const { db } = loadDbWithFakePrisma();
  await withMockedDiscordFetch([{ status: 404, body: {} }], async () => {
    const result = await db.getMemberDiscordRoleIds('guild-1', 'user-1');
    assert.equal(result, null);
  });
});

test('getMemberDiscordRoleIds returns null on a network error, never throws', async () => {
  const { db } = loadDbWithFakePrisma();
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await db.getMemberDiscordRoleIds('guild-1', 'user-1');
    assert.equal(result, null);
  } finally {
    global.fetch = realFetch;
  }
});

test('a Discord outage while checking role-based permissions fails closed (denies), never accidentally grants access', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'someone', discordUsername: 'Someone' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: 'role-a', permissions: { canSubmitBugs: true } });

  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('Discord is down'); };
  try {
    const perms = await db.getEffectivePermissions(server.id, 'someone');
    assert.equal(perms, null, 'an outage must never accidentally grant access');
  } finally {
    global.fetch = realFetch;
  }
});

test('getDiscordRoleHierarchy returns null (not a crash) on a Discord failure, and rank-safety checks reject rather than silently allow', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'dev1', discordUsername: 'Dev' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: 'dev-role', permissions: { canManageRoles: true } });

  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/members/')) return { ok: true, status: 200, json: async () => ({ roles: ['dev-role'] }) };
    throw new Error('roles endpoint down'); // getDiscordRoleHierarchy fails
  };
  try {
    await assert.rejects(
      () => db.setRolePermissions({ serverId: server.id, actingDiscordId: 'dev1', discordRoleId: 'some-role', permissions: {} }),
      /Could not verify.*hierarchy/i,
      'cannot verify hierarchy safely -> reject rather than silently allow a rank-unsafe change',
    );
  } finally {
    global.fetch = realFetch;
  }
});
