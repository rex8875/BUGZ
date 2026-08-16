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
  app.use((req, res, next) => { req.session = { discordId }; next(); });
  app.use(router);
  return app;
}

async function seedServerWithTerminalReport(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  const report = await db.createBugReport(server.id, 'owner1', { title: 'A bug', description: 'd', priority: 'LOW', status: 'FIXED' });
  return { server, report };
}

test('POST .../archive: succeeds through the real route for a terminal-status report, and the response reflects it', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const { server, report } = await seedServerWithTerminalReport(db);
    const app = buildTestApp(router, 'owner1');

    const res = await request(app).post(`/api/servers/${server.id}/reports/${report.id}/archive`);
    assert.equal(res.status, 200);
    assert.ok(res.body.archivedAt, 'the response should reflect the new archived state');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('POST .../archive: a non-terminal-status report is rejected with 400 through the real route', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    const report = await db.createBugReport(server.id, 'owner1', { title: 'A bug', description: 'd', priority: 'LOW', status: 'NEW' });

    const app = buildTestApp(router, 'owner1');
    const res = await request(app).post(`/api/servers/${server.id}/reports/${report.id}/archive`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Status must be/);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('POST .../unarchive: works through the real route regardless of status, and PATCHing status while still archived is rejected', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const { server, report } = await seedServerWithTerminalReport(db);
    const app = buildTestApp(router, 'owner1');
    await request(app).post(`/api/servers/${server.id}/reports/${report.id}/archive`);

    const patchWhileArchived = await request(app)
      .patch(`/api/servers/${server.id}/reports/${report.id}`)
      .send({ status: 'NEW' });
    assert.equal(patchWhileArchived.status, 400);
    assert.match(patchWhileArchived.body.error, /locked while this report is archived/);

    const unarchiveRes = await request(app).post(`/api/servers/${server.id}/reports/${report.id}/unarchive`);
    assert.equal(unarchiveRes.status, 200);
    assert.equal(unarchiveRes.body.archivedAt, null);

    const patchAfterUnarchive = await request(app)
      .patch(`/api/servers/${server.id}/reports/${report.id}`)
      .send({ status: 'NEW' });
    assert.equal(patchAfterUnarchive.status, 200);
    assert.equal(patchAfterUnarchive.body.status, 'NEW', 'status should be editable again once unarchived');
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('POST .../archive and .../unarchive on a report id from a different server both 400 through the real route (server-scoping enforced at the route, not just the DB layer)', async () => {
  const { db, router, dbModulePath, originalDbCache } = loadApiRouteWithFakeDb();
  try {
    const { report } = await seedServerWithTerminalReport(db);
    const otherServer = await db.createServerOnJoin({ discordServerId: 'g2', name: 'Other', ownerDiscordId: 'owner2' });
    await db.verifyUser({ discordId: 'owner2', discordUsername: 'Owner2' });

    const app = buildTestApp(router, 'owner2');
    const res = await request(app).post(`/api/servers/${otherServer.id}/reports/${report.id}/archive`);
    assert.equal(res.status, 400);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
