const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { installDiscordRoleMock } = require('../../../packages/db/test/helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

function loadApiRouteWithFakeDb() {
  const { loadDbWithFakePrisma } = require('../../../packages/db/test/helpers/loadDb');
  const { db } = loadDbWithFakePrisma();

  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: db };

  const discordRestPath = require.resolve('../src/lib/discordRest.js');
  delete require.cache[discordRestPath];

  const routePath = require.resolve('../src/routes/api.js');
  delete require.cache[routePath];
  const router = require(routePath);

  return { db, router, dbModulePath, originalDbCache };
}

function buildTestApp(router, discordId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { discordId }; next(); });
  app.use(router);
  return app;
}

test('live dashboard access: role removed between two real HTTP requests immediately 403s the second one — no session caching of permissions', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
    await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canViewDashboard: true } });
    roleMock.setMemberRoles('tester1', [TESTER_ROLE]);

    const app = buildTestApp(router, 'tester1');

    const first = await request(app).get(`/api/servers/${server.id}/reports`);
    assert.equal(first.status, 200, 'the dashboard is reachable while the role is held');

    // The role is taken away in Discord itself, mid-session, with no
    // action taken on the bot/dashboard side at all -- same as an
    // owner just editing roles in the Discord UI.
    roleMock.setMemberRoles('tester1', []);

    const second = await request(app).get(`/api/servers/${server.id}/reports`);
    assert.equal(second.status, 403, 'the very next request, with no other change, must be denied -- permissions are never cached from the first request');
    assert.match(second.body.error, /no dashboard access/i);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('live dashboard access: re-granting the role after removal restores access on the next request, still no bot-side action needed', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
    await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canViewDashboard: true } });

    const app = buildTestApp(router, 'tester1');

    roleMock.setMemberRoles('tester1', []);
    const denied = await request(app).get(`/api/servers/${server.id}/reports`);
    assert.equal(denied.status, 403);

    roleMock.setMemberRoles('tester1', [TESTER_ROLE]);
    const restored = await request(app).get(`/api/servers/${server.id}/reports`);
    assert.equal(restored.status, 200, 'granting the role again should restore access on the very next request too');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('live dashboard access: a mutating action (PATCH settings) is also blocked immediately after role removal, not just the read route', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
    // Grants dashboard viewing AND settings management.
    await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canViewDashboard: true, canManageSettings: true } });
    roleMock.setMemberRoles('tester1', [TESTER_ROLE]);

    const app = buildTestApp(router, 'tester1');
    const before = await request(app).patch(`/api/servers/${server.id}/settings`).send({ retestChannelId: 'chan-1' });
    assert.equal(before.status, 200, 'settings update works while the role granting canManageSettings is held');

    roleMock.setMemberRoles('tester1', []);
    const after = await request(app).patch(`/api/servers/${server.id}/settings`).send({ retestChannelId: 'chan-2' });
    assert.equal(after.status, 403, 'the mutating route is blocked immediately too, same as the read route');

    const finalServer = await db.getServerByDiscordId('g1');
    assert.equal(finalServer.retestChannelId, 'chan-1', 'the blocked attempt must not have taken effect');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
