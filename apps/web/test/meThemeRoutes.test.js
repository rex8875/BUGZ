const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

function loadApiRouteWithFakeDb() {
  const { loadDbWithFakePrisma } = require('../../../packages/db/test/helpers/loadDb');
  const { db } = loadDbWithFakePrisma();

  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: db };

  const routePath = require.resolve('../src/routes/api.js');
  delete require.cache[routePath];
  const router = require(routePath);

  return { db, router, dbModulePath, originalDbCache };
}

function buildTestApp(router, discordId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = discordId ? { discordId } : {};
    next();
  });
  app.use(router);
  return app;
}

test('GET /api/me/theme requires being signed in', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const app = buildTestApp(router, null);
    const res = await request(app).get('/api/me/theme');
    assert.equal(res.status, 401);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('GET /api/me/theme defaults to ink, and PUT saves a new choice that GET then reflects', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });
    const app = buildTestApp(router, 'u1');

    const before = await request(app).get('/api/me/theme');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { theme: 'ink' });

    const put = await request(app).put('/api/me/theme').send({ theme: 'aurora' });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { theme: 'aurora' });

    const after = await request(app).get('/api/me/theme');
    assert.deepEqual(after.body, { theme: 'aurora' });
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('PUT /api/me/theme rejects an unrecognized theme with 400, and leaves the saved value untouched', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });
    const app = buildTestApp(router, 'u1');
    await request(app).put('/api/me/theme').send({ theme: 'mesh' });

    const bad = await request(app).put('/api/me/theme').send({ theme: 'not-a-real-theme' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error);

    const after = await request(app).get('/api/me/theme');
    assert.deepEqual(after.body, { theme: 'mesh' }, 'the rejected PUT must not have overwritten the previously-saved theme');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('theme is scoped to /api/me, not any one server — no :serverId in the URL, and two different accounts stay independent', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });
    await db.verifyUser({ discordId: 'u2', discordUsername: 'Someone Else' });

    await request(buildTestApp(router, 'u1')).put('/api/me/theme').send({ theme: 'cyber' });

    const u1 = await request(buildTestApp(router, 'u1')).get('/api/me/theme');
    const u2 = await request(buildTestApp(router, 'u2')).get('/api/me/theme');
    assert.deepEqual(u1.body, { theme: 'cyber' });
    assert.deepEqual(u2.body, { theme: 'ink' }, "u2 must see their own default, not u1's choice");
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
