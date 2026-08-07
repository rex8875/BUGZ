const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { installDiscordRoleMock } = require('../../../packages/db/test/helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

function loadPublicReportRouteWithFakeDb() {
  const { loadDbWithFakePrisma } = require('../../../packages/db/test/helpers/loadDb');
  const { db } = loadDbWithFakePrisma();

  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: db };

  const routePath = require.resolve('../src/routes/publicReport.js');
  delete require.cache[routePath];
  const router = require(routePath);

  const app = express();
  app.use(router);

  return { app, db, dbModulePath, originalDbCache };
}

async function seedServerAndReport(db, roleMock) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Alpha Testers', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'reporter1', discordUsername: 'Tester1' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
  roleMock.setMemberRoles('reporter1', [TESTER_ROLE]);
  const report = await db.createBugReport(server.id, 'reporter1', {
    title: 'Floor breaks on level 3',
    description: 'Standing near the crate makes you fall through.',
    priority: 'HIGH',
    device: 'PC',
    evidenceLink: 'https://example.com/secret-clip',
    f9Link: 'https://example.com/secret-f9',
  });
  return { server, report };
}

test('GET /r/:reportId serves a page with correct Open Graph tags for Discord to unfurl, with no login required', async () => {
  const { app, db, dbModulePath, originalDbCache } = loadPublicReportRouteWithFakeDb();
  const realBaseUrl = process.env.WEB_BASE_URL;
  process.env.WEB_BASE_URL = 'https://bugz.example.com';
  const roleMock = installDiscordRoleMock();
  try {
    const { report } = await seedServerAndReport(db, roleMock);

    const res = await request(app).get(`/r/${report.id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /<meta property="og:title" content="Bug #1: Floor breaks on level 3"/);
    assert.match(res.text, /<meta property="og:description" content="New · High/);
    assert.match(res.text, /Field Log — Alpha Testers/);
  } finally {
    process.env.WEB_BASE_URL = realBaseUrl;
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('GET /r/:reportId never leaks evidence/F9 links — those still require real dashboard access', async () => {
  const { app, db, dbModulePath, originalDbCache } = loadPublicReportRouteWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const { report } = await seedServerAndReport(db, roleMock);
    const res = await request(app).get(`/r/${report.id}`);
    assert.equal(res.text.includes('secret-clip'), false, 'evidence link must not appear on the public page');
    assert.equal(res.text.includes('secret-f9'), false, 'F9 link must not appear on the public page');
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('GET /r/:reportId returns 404 for a nonexistent report instead of leaking a stack trace', async () => {
  const { app, dbModulePath, originalDbCache } = loadPublicReportRouteWithFakeDb();
  try {
    const res = await request(app).get('/r/does-not-exist');
    assert.equal(res.status, 404);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});

test('GET /r/:reportId shows the actual report content (title, description, tags) for a human visitor, not just OG tags', async () => {
  const { app, db, dbModulePath, originalDbCache } = loadPublicReportRouteWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    const { report } = await seedServerAndReport(db, roleMock);
    const res = await request(app).get(`/r/${report.id}`);
    assert.match(res.text, /Floor breaks on level 3/);
    assert.match(res.text, /Standing near the crate makes you fall through\./);
    assert.match(res.text, /tag-priority-HIGH/);
    assert.match(res.text, /tag-status-NEW/);
    assert.match(res.text, /Tester1/);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
});
