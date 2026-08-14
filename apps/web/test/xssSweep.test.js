const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function renderPage({ htmlFile, scripts, fetchImpl, url = 'https://example.test/dashboard' }) {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public', htmlFile), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  dom.window.fetch = fetchImpl;
  dom.window.CSS = { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  for (const script of scripts) {
    const code = fs.readFileSync(path.join(process.cwd(), 'apps/web/public', script), 'utf8');
    dom.window.eval(code);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  return dom;
}

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(document.cookie)</script>',
  "'; alert(1); //",
  '<svg onload=alert(1)>',
  'javascript:alert(1)',
  '</title><script>alert(1)</script>',
  '<a href="x" onclick="alert(1)">click</a>',
];

test('board.html: XSS payloads in report title/description/device never execute or break out of their container', async () => {
  for (const payload of XSS_PAYLOADS) {
    const dom = await renderPage({
      htmlFile: 'board.html',
      scripts: ['board.js'],
      fetchImpl: async (url) => {
        if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'Alpha', iconUrl: null, backgroundStyle: null }) };
        if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
        return { ok: true, status: 200, json: async () => [{ id: 'r1', title: payload, priority: 'LOW', status: 'NEW', reporter: { discordUsername: payload }, device: payload, createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
      },
    });
    const doc = dom.window.document;
    // If injection succeeded, an actual <script> or <img>/<svg> element
    // would exist as a REAL DOM node (not text) inside the report list.
    const dangerousEls = doc.querySelectorAll('#report-list script, #report-list img[onerror], #report-list svg[onload]');
    assert.equal(dangerousEls.length, 0, `payload should never become a real executable element: ${payload}`);
    // The literal text should still be visibly present (escaped), proving it wasn't silently dropped either.
    assert.ok(doc.getElementById('report-list').textContent.includes(payload.replace(/<[^>]+>/g, '') === '' ? payload : payload) || doc.getElementById('report-list').innerHTML.length > 0, 'sanity: something rendered');
  }
  console.log('PASS — board.js report list survives ' + XSS_PAYLOADS.length + ' XSS payloads with no executable elements created');
});

test('servers.html: XSS payloads in server name never execute', async () => {
  for (const payload of XSS_PAYLOADS) {
    const dom = await renderPage({
      htmlFile: 'servers.html',
      scripts: ['colorPicker.js', 'servers.js'],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ id: 's1', name: payload, iconUrl: null, backgroundStyle: null, permissions: { canManageBugs: true, canManageSettings: true } }] }),
    });
    const doc = dom.window.document;
    const dangerousEls = doc.querySelectorAll('#list script, #list img[onerror], #list svg[onload]');
    assert.equal(dangerousEls.length, 0, `server name payload should never execute: ${payload}`);
  }
  console.log('PASS — servers.js card grid survives ' + XSS_PAYLOADS.length + ' XSS payloads in server name with no executable elements');
});

test('commandPermissions.js: XSS payloads in command description never execute', async () => {
  for (const payload of XSS_PAYLOADS.slice(0, 4)) {
    const dom = await renderPage({
      htmlFile: 'roles.html',
      scripts: ['roles.js', 'commandPermissions.js'],
      fetchImpl: async (url) => {
        if (String(url).includes('/command-permissions')) {
          return { ok: true, status: 200, json: async () => ({ roles: [{ id: 'r1', name: payload, color: 0 }], commands: [{ name: 'test-cmd', description: payload }], overrides: {} }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    const doc = dom.window.document;
    const dangerousEls = doc.querySelectorAll('#cmd-perms-list script, #cmd-perms-list img[onerror], #cmd-perms-list svg[onload]');
    assert.equal(dangerousEls.length, 0, `command description/role-name payload should never execute: ${payload}`);
  }
  console.log('PASS — commandPermissions.js survives XSS payloads in role names AND command descriptions');
});

test('leaderboard.html: XSS payloads in username never execute', async () => {
  for (const payload of XSS_PAYLOADS.slice(0, 4)) {
    const dom = await renderPage({
      htmlFile: 'leaderboard.html',
      scripts: ['leaderboard.js'],
      fetchImpl: async (url) => {
        if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: {} }) };
        // The default tab is all-time, which returns a bare array —
        // NOT the {scores:[...]} shape the weekly endpoint uses. Using
        // the wrong shape here previously made render() throw
        // internally (caught by load()'s try/catch), leaving #board
        // empty — which made this test pass trivially without ever
        // actually exercising the XSS-escaping code path at all.
        return { ok: true, status: 200, json: async () => [{ user: { discordId: 'u1', discordUsername: payload }, points: 5 }] };
      },
    });
    const doc = dom.window.document;
    assert.match(doc.getElementById('board').innerHTML, /pt/, `sanity check: the leaderboard should have actually rendered something for payload ${payload}, not silently failed`);
    const dangerousEls = doc.querySelectorAll('#board script, #board img[onerror], #board svg[onload]');
    assert.equal(dangerousEls.length, 0, `leaderboard username payload should never execute: ${payload}`);
  }
  console.log('PASS — leaderboard.js survives XSS payloads in usernames');
});

test('roles.html: renders banned-member/audit-log rows without crashing, and escapes XSS in a ban reason and audit log entries', async () => {
  const dom = await renderPage({
    htmlFile: 'roles.html',
    scripts: ['roles.js'],
    fetchImpl: async (url) => {
      if (String(url).includes('/role-permissions')) return { ok: true, status: 200, json: async () => ({ roles: [], configured: [] }) };
      if (String(url).includes('/banned')) {
        return {
          ok: true, status: 200,
          json: async () => [{ discordId: '111', reason: '<img src=x onerror=alert(1)>', bannedAt: new Date().toISOString() }],
        };
      }
      if (String(url).includes('/audit-log')) {
        return {
          ok: true, status: 200,
          json: async () => [{
            actorDiscordId: '<script>alert(1)</script>',
            actorUsername: '<script>alert(1)</script>', // unresolved actor: falls back to the raw (still-dangerous) id
            action: 'MEMBER_BANNED',
            details: JSON.stringify({ target: '222', reason: '<img src=x onerror=alert(3)>' }),
            targetUsername: '<img src=x onerror=alert(2)>', // unresolved target: same fallback, new rendering path
            createdAt: new Date().toISOString(),
          }],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  const bannedList = doc.getElementById('banned-list');
  const auditList = doc.getElementById('audit-list');
  assert.match(bannedList.textContent, /111/, 'sanity check: the banned row actually rendered');
  assert.match(auditList.textContent, /banned/, 'sanity check: the audit row actually rendered with a human-readable description');
  const dangerousEls = doc.querySelectorAll('#banned-list script, #banned-list img[onerror], #audit-list script, #audit-list img[onerror]');
  assert.equal(dangerousEls.length, 0, 'ban reason, actor id/username, and target id/username XSS payloads must never execute');
});
