const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

function withMockedDiscordFetch(rolesResponse, commandsResponse, fn) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/roles')) return { ok: true, status: 200, json: async () => rolesResponse };
    if (String(url).includes('/commands')) return { ok: true, status: 200, json: async () => commandsResponse };
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  return fn().finally(() => { global.fetch = realFetch; });
}

function loadApiRouteWithFakeDb() {
  const { loadDbWithFakePrisma } = require('../../../packages/db/test/helpers/loadDb');
  const { db } = loadDbWithFakePrisma();

  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: db };

  const discordRestPath = require.resolve('../src/lib/discordRest.js');
  delete require.cache[discordRestPath]; // fresh require so it re-reads global.fetch each test

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

async function seedServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  return server;
}

test('GET command-permissions returns real Discord roles (minus @everyone) and registered commands, merged with current overrides', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const server = await seedServer(db);
    await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['role-qa'] });

    const app = buildTestApp(router, 'owner1');
    const rolesResponse = [
      { id: 'g1', name: '@everyone', color: 0 }, // same id as the guild = @everyone, must be filtered out
      { id: 'role-qa', name: 'QA Lead', color: 0xff0000 },
      { id: 'role-mod', name: 'Moderator', color: 0x00ff00 },
    ];
    const commandsResponse = [{ name: 'reset-score', description: "Reset someone's leaderboard score" }, { name: 'take-role', description: 'Remove a role' }];

    await withMockedDiscordFetch(rolesResponse, commandsResponse, async () => {
      const res = await request(app).get(`/api/servers/${server.id}/command-permissions`);
      assert.equal(res.status, 200);
      assert.equal(res.body.roles.length, 2, '@everyone must be filtered out');
      assert.ok(!res.body.roles.some((r) => r.name === '@everyone'));
      assert.equal(res.body.commands.length, 2);
      assert.deepEqual(res.body.overrides['reset-score'], ['role-qa']);
    });
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('GET command-permissions is forbidden for someone without canManageSettings', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const server = await seedServer(db);
    const app = buildTestApp(router, 'tester1');
    await withMockedDiscordFetch([], [], async () => {
      const res = await request(app).get(`/api/servers/${server.id}/command-permissions`);
      assert.equal(res.status, 403);
    });
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('PATCH command-permissions sets an override that GET then reflects', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const server = await seedServer(db);
    const app = buildTestApp(router, 'owner1');

    const res = await request(app)
      .patch(`/api/servers/${server.id}/command-permissions/reset-score`)
      .send({ discordRoleIds: ['role-a', 'role-b'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.discordRoleIds.sort(), ['role-a', 'role-b']);

    const stored = await db.getCommandRoleOverride(server.id, 'reset-score');
    assert.deepEqual(stored.sort(), ['role-a', 'role-b']);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('PATCH command-permissions is forbidden for someone without canManageSettings', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const server = await seedServer(db);
    const app = buildTestApp(router, 'tester1');
    const res = await request(app)
      .patch(`/api/servers/${server.id}/command-permissions/reset-score`)
      .send({ discordRoleIds: ['role-a'] });
    assert.equal(res.status, 403);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('GET command-permissions returns a clean 502 if Discord itself is unreachable, not a stack trace', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const server = await seedServer(db);
    const app = buildTestApp(router, 'owner1');
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    try {
      const res = await request(app).get(`/api/servers/${server.id}/command-permissions`);
      assert.equal(res.status, 502);
    } finally {
      global.fetch = realFetch;
    }
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
