const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function renderPage({ htmlFile, scripts, fetchImpl, url = 'https://example.test/dashboard/s1' }) {
  const html = fs.readFileSync(path.join(__dirname, '../public', htmlFile), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  dom.window.fetch = fetchImpl;
  for (const script of scripts) {
    const code = fs.readFileSync(path.join(__dirname, '../public', script), 'utf8');
    dom.window.eval(code);
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  return dom;
}

function baseFetch(reports) {
  return async (url) => {
    if (String(url).includes('/me')) {
      return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canEditReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'A', iconUrl: null, backgroundStyle: null }) };
    }
    if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: reports.length }) };
    return { ok: true, status: 200, json: async () => ({ reports, page: 1, totalPages: 1, totalCount: reports.length }) };
  };
}

function typeAndGetSuggestions(dom, value, cursorPos = value.length) {
  const doc = dom.window.document;
  const input = doc.getElementById('search-input');
  input.value = value;
  input.setSelectionRange(cursorPos, cursorPos);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return doc.getElementById('search-suggest');
}

test('typing a partial filter key shows matching key suggestions', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch([]) });
  const box = typeAndGetSuggestions(dom, 'b');
  assert.equal(box.style.display, 'block');
  const subs = [...box.querySelectorAll('.search-suggest-sub')].map((el) => el.textContent);
  assert.ok(subs.some((s) => s.startsWith('before:')), 'should suggest before: for prefix "b"');
  assert.ok(subs.some((s) => s.startsWith('by:')), 'should suggest by: for prefix "b"');
  assert.ok(!subs.some((s) => s.startsWith('on:')), 'should NOT suggest on: since it does not start with "b"');
});

test('typing by:<partial> suggests matching reporter usernames from the currently loaded reports', async () => {
  const reports = [
    { id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'alice' }, device: 'PC', createdAt: new Date().toISOString() },
    { id: 'r2', title: 'Bug2', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'alexander' }, device: 'PC', createdAt: new Date().toISOString() },
    { id: 'r3', title: 'Bug3', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'bob' }, device: 'PC', createdAt: new Date().toISOString() },
  ];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch(reports) });
  const box = typeAndGetSuggestions(dom, 'by:al');
  const labels = [...box.querySelectorAll('.search-suggest-label')].map((el) => el.textContent);
  assert.deepEqual(labels.sort(), ['alexander', 'alice'], 'only usernames containing "al" should be suggested');
});

test('typing device:<partial> suggests matching known device values, not arbitrary text', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch([]) });
  const box = typeAndGetSuggestions(dom, 'device:p');
  const labels = [...box.querySelectorAll('.search-suggest-label')].map((el) => el.textContent);
  assert.deepEqual(labels, ['PC']);
});

test('clicking a key suggestion splices it into just the current token, leaving the rest of the input untouched', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch([]) });
  const doc = dom.window.document;
  const input = doc.getElementById('search-input');
  const box = typeAndGetSuggestions(dom, 'crash by');
  const byItem = [...box.querySelectorAll('.search-suggest-item')].find((el) => el.querySelector('.search-suggest-sub').textContent.startsWith('by:'));
  byItem.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(input.value, 'crash by:', 'only the "by" token should be replaced with "by:", the leading "crash " must survive untouched');
});

test('pressing Escape closes the suggestion box without altering the input', async () => {
  const reports = [{ id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW', reporter: { discordUsername: 'alice' }, device: 'PC', createdAt: new Date().toISOString() }];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch(reports) });
  const doc = dom.window.document;
  const input = doc.getElementById('search-input');
  const box = typeAndGetSuggestions(dom, 'by:al');
  assert.equal(box.style.display, 'block');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(box.style.display, 'none');
  assert.equal(input.value, 'by:al', 'Escape should only close the dropdown, never clear or change what was typed');
});

test('typing plain free-text search words (no matching key) hides the suggestion box', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch([]) });
  const box = typeAndGetSuggestions(dom, 'crash on startup zzz');
  assert.equal(box.style.display, 'none', 'a trailing word that matches no known key/value should not show a dropdown');
});

test('ArrowDown then Enter selects the highlighted suggestion, same as clicking it', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: baseFetch([]) });
  const doc = dom.window.document;
  const input = doc.getElementById('search-input');
  typeAndGetSuggestions(dom, 'dev');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(input.value, 'device:', 'ArrowDown + Enter should apply the (only) matching suggestion, "device:"');
});
