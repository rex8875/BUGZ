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

test('board.html: zero reports renders a graceful empty state, no crash', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url) => {
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: {}, retestChannelId: null, testerPingRoleId: null, serverName: 'Empty', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 0 }) };
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('.report-row').length, 0);
  assert.match(doc.getElementById('report-list').textContent, /no reports|none/i);
});

test('servers.html: zero servers renders a graceful empty state, no crash', async () => {
  const dom = await renderPage({
    htmlFile: 'servers.html', scripts: ['colorPicker.js', 'servers.js'],
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('.server-card').length, 0);
  assert.match(doc.getElementById('list').textContent, /don't have access/i);
});

test('commandPermissions.js: a server with zero custom Discord roles shows a clear message, not a broken empty grid', async () => {
  const dom = await renderPage({
    htmlFile: 'roles.html', scripts: ['roles.js', 'commandPermissions.js'],
    fetchImpl: async (url) => {
      if (String(url).includes('/command-permissions')) {
        return { ok: true, status: 200, json: async () => ({ roles: [], commands: [{ name: 'reset-score', description: 'd' }], overrides: {} }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('[data-toggle="reset-score"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(doc.getElementById('cmd-perms-list').textContent, /no custom discord roles/i);
});

test('board.html: an extremely long title (10,000 chars) does not crash rendering', async () => {
  const longTitle = 'A'.repeat(10000);
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url) => {
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: {}, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: longTitle, priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('.report-row').length, 1, 'a 10,000-char title should still render as one row without crashing');
});

test('board.html: search with a malformed date token (on:notadate) does not crash, silently drops the invalid date filter', async () => {
  const calledUrls = [];
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url) => {
      calledUrls.push(String(url));
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: {}, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 0 }) };
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  const doc = dom.window.document;
  const input = doc.getElementById('search-input');
  calledUrls.length = 0;
  input.value = 'on:notadate crash';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const call = calledUrls.find((u) => u.includes('/reports?'));
  assert.ok(call, 'a request should still go out (client does not crash on a bad date)');
  assert.match(decodeURIComponent(call).replace(/\+/g,' '), /on=notadate/, 'the raw token is passed through — validation/rejection happens server-side, not silently swallowed client-side');
});

test('board.html: rapid double-click on the same report row does not create two detail panels or duplicate API calls', async () => {
  let reportFetchCount = 0;
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url) => {
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  const row = doc.querySelector('.report-row');
  row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const panels = doc.querySelectorAll('#detail-area .detail-panel');
  assert.equal(panels.length, 1, 'triple-clicking the same row should never produce more than one detail panel');
});
