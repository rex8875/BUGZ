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

test('board.html: repeatedly clicking the same report row does not create two detail panels or duplicate API calls', async () => {
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
  // Three separate clicks on the same row: 1st selects (quick view), 2nd
  // expands (full view), 3rd is a no-op while already expanded (matching
  // "use the × to close it" rather than toggling on every click).
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const panels = doc.querySelectorAll('#report-list .detail-panel');
  assert.equal(panels.length, 1, 'repeated clicks on the same row should never produce more than one detail panel');
});

test('board.html: the detail panel\'s close button collapses it back to quick view without a page reload', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url) => {
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(doc.querySelector('#report-list .detail-panel'), 'sanity check: detail panel should be open');

  doc.querySelector('[data-close-detail]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(doc.querySelector('#report-list .detail-panel'), null, 'the close button must remove the detail panel entirely, with no page reload required');
  assert.ok(doc.querySelector('.report-row.selected'), 'the row itself should remain selected (quick view), only the full view collapses');
});

test('board.html: deleting a report requires confirmation — cancelling must not send a delete request', async () => {
  const calls = [];
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  doc.querySelector('[data-delete-report]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(doc.getElementById('confirm-modal').style.display, 'flex', 'sanity check: the confirm modal should be open');
  doc.getElementById('confirm-modal-cancel').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(doc.getElementById('confirm-modal').style.display, 'none', 'the modal should close on cancel');
  assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'cancelling the confirmation must never send the delete request');
  assert.ok(doc.querySelector('#report-list .detail-panel'), 'the report should still be visible, nothing was deleted');
});

test('board.html: confirming the delete dialog actually removes the report from the list', async () => {
  const calls = [];
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      if (options.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  doc.querySelector('[data-delete-report]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.getElementById('confirm-modal-confirm').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('r1')), 'confirming should send the DELETE request for the right report');
  assert.equal(doc.querySelector('.report-row'), null, 'the deleted report must no longer appear in the list');
});

test('board.html: pressing Escape while the confirm modal is open cancels it', async () => {
  const calls = [];
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  doc.querySelector('[data-delete-report]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(doc.getElementById('confirm-modal').style.display, 'none', 'Escape should close the modal');
  assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'Escape must not confirm the deletion');
});

test('board.html: editing the title cancels cleanly on Escape — no PATCH sent, original text restored', async () => {
  const calls = [];
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Original title', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  doc.querySelector('[data-edit-title]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.querySelector('.detail-title-row .inline-edit-field');
  assert.ok(field, 'sanity check: editing should swap in a real input, no popup');
  field.value = 'Something I changed my mind about';
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(calls.some((c) => c.method === 'PATCH'), false, 'Escape must never send a PATCH request');
  assert.equal(doc.querySelector('.detail-title-row .inline-edit-field'), null, 'the field should revert back to display text');
  assert.match(doc.querySelector('[data-title-text]').textContent, /Original title/);
});

test('board.html: editing the title actually updates it when Enter is pressed with a new value', async () => {
  const calls = [];
  const dom = await renderPage({
    htmlFile: 'board.html', scripts: ['board.js'],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 1 }) };
      if (options.method === 'PATCH') return { ok: true, status: 200, json: async () => ({ id: 'r1', title: 'Brand new title', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString() }) };
      return { ok: true, status: 200, json: async () => [{ id: 'r1', title: 'Original title', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'u' }, device: 'PC', createdAt: new Date().toISOString(), evidenceLink: null, f9Link: null }] };
    },
  });
  const doc = dom.window.document;
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  doc.querySelector('.report-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  doc.querySelector('[data-edit-title]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.querySelector('.detail-title-row .inline-edit-field');
  field.value = 'Brand new title';
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));

  const patchCall = calls.find((c) => c.method === 'PATCH');
  assert.ok(patchCall, 'a PATCH request should have been sent');
  assert.deepEqual(JSON.parse(patchCall.body), { title: 'Brand new title' });
  assert.match(doc.querySelector('.report-row .title').textContent, /Brand new title/);
});
