const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  return server;
}

test('isSafeLinkUrl accepts http and https URLs', async () => {
  const { db } = loadDbWithFakePrisma();
  assert.equal(db.isSafeLinkUrl('https://example.com/clip.mp4'), true);
  assert.equal(db.isSafeLinkUrl('http://example.com'), true);
});

test('isSafeLinkUrl rejects the javascript: scheme (the actual XSS vector this exists to stop)', async () => {
  const { db } = loadDbWithFakePrisma();
  assert.equal(db.isSafeLinkUrl('javascript:alert(document.cookie)'), false);
  assert.equal(db.isSafeLinkUrl('JaVaScRiPt:alert(1)'), false, 'must not be bypassable via case variation');
});

test('isSafeLinkUrl rejects other dangerous or nonsensical schemes', async () => {
  const { db } = loadDbWithFakePrisma();
  assert.equal(db.isSafeLinkUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(db.isSafeLinkUrl('vbscript:msgbox(1)'), false);
  assert.equal(db.isSafeLinkUrl('file:///etc/passwd'), false);
  assert.equal(db.isSafeLinkUrl('not a url at all'), false);
  assert.equal(db.isSafeLinkUrl(''), false);
  assert.equal(db.isSafeLinkUrl(null), false);
  assert.equal(db.isSafeLinkUrl(undefined), false);
});

test('createBugReport rejects a javascript: URL submitted as the evidence link', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServer(db);
  await assert.rejects(
    () =>
      db.createBugReport(server.id, 'owner1', {
        title: 'Bug', description: 'd', priority: 'LOW', device: 'PC',
        evidenceLink: 'javascript:alert(document.cookie)',
        f9Link: 'https://example.com/f9.png',
      }),
    /valid http/i,
  );
});

test('createBugReport rejects a javascript: URL submitted as the F9 link', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServer(db);
  await assert.rejects(
    () =>
      db.createBugReport(server.id, 'owner1', {
        title: 'Bug', description: 'd', priority: 'LOW', device: 'PC',
        evidenceLink: 'https://example.com/clip.mp4',
        f9Link: 'javascript:alert(1)',
      }),
    /valid http/i,
  );
});

test('createBugReport still accepts legitimate http(s) evidence/F9 links (no regression)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await setupServer(db);
  const report = await db.createBugReport(server.id, 'owner1', {
    title: 'Bug', description: 'd', priority: 'LOW', device: 'PC',
    evidenceLink: 'https://example.com/clip.mp4',
    f9Link: 'https://example.com/f9.png',
  });
  assert.equal(report.evidenceLink, 'https://example.com/clip.mp4');
  assert.equal(report.f9Link, 'https://example.com/f9.png');
});
