const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function loadThemeJs() {
  return fs.readFileSync(path.join(process.cwd(), 'apps/web/public/theme.js'), 'utf8');
}

test('theme.js: with no saved preference, no theme-* class is applied (Ink stays the default), and the picker button renders into the server rail', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/board.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard' });
  dom.window.eval(loadThemeJs());
  await new Promise((r) => setTimeout(r, 30));

  const doc = dom.window.document;
  assert.equal([...doc.body.classList].some((c) => c.startsWith('theme-')), false, 'no theme class should be applied by default');
  const btn = doc.querySelector('#server-rail .theme-picker-btn');
  assert.ok(btn, 'the theme picker button should be appended into the server rail');
});

test('theme.js: clicking a swatch applies the matching body class and persists the choice', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/board.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard' });
  dom.window.eval(loadThemeJs());
  await new Promise((r) => setTimeout(r, 30));

  const doc = dom.window.document;
  doc.querySelector('.theme-picker-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const popover = doc.querySelector('.theme-picker-popover');
  assert.ok(popover.classList.contains('open'), 'the popover should open on click');

  doc.querySelector('[data-theme="aurora"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.ok(doc.body.classList.contains('theme-aurora'), 'the body should get the theme-aurora class');
  assert.equal(dom.window.localStorage.getItem('fieldlog-theme'), 'aurora', 'the choice should be persisted so it survives a reload');
});

test('theme.js: a previously-saved preference is applied immediately on the next page load, on every page (not just board.html)', async () => {
  for (const htmlFile of ['board.html', 'servers.html', 'roles.html', 'leaderboard.html']) {
    const html = fs.readFileSync(path.join(process.cwd(), `apps/web/public/${htmlFile}`), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/page' });
    dom.window.localStorage.setItem('fieldlog-theme', 'glass');
    dom.window.eval(loadThemeJs());
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(dom.window.document.body.classList.contains('theme-glass'), `${htmlFile} should apply the saved theme-glass class`);
  }
});

test('theme.js: an unrecognized/corrupted stored value falls back to the default instead of crashing', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/board.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard' });
  dom.window.localStorage.setItem('fieldlog-theme', 'not-a-real-theme');
  dom.window.eval(loadThemeJs());
  await new Promise((r) => setTimeout(r, 30));

  assert.equal([...dom.window.document.body.classList].some((c) => c.startsWith('theme-')), false, 'an invalid stored value should fall back to Ink, not apply a bogus class');
});

test('theme.js: a theme saved on another device (different from what is cached locally) wins once the account sync resolves', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/board.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard' });
  // Nothing cached locally yet (fresh browser), but the account already
  // has "duotone" saved from using the dashboard elsewhere.
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ theme: 'duotone' }) });
  dom.window.eval(loadThemeJs());
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(dom.window.document.body.classList.contains('theme-duotone'), 'the account theme should win once the sync resolves');
  assert.equal(dom.window.localStorage.getItem('fieldlog-theme'), 'duotone', 'the local cache should be updated to match, so the next load is instant and correct');
});

test('theme.js: picking a theme saves it to the account, not just locally', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/board.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard' });
  const calls = [];
  dom.window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (!options.method) return { ok: true, json: async () => ({ theme: 'ink' }) }; // the background reconciliation GET
    return { ok: true, json: async () => ({ theme: 'cyber' }) };
  };
  dom.window.eval(loadThemeJs());
  await new Promise((r) => setTimeout(r, 30));

  const doc = dom.window.document;
  doc.querySelector('.theme-picker-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  doc.querySelector('[data-theme="cyber"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const saveCall = calls.find((c) => c.method === 'PUT');
  assert.ok(saveCall, 'selecting a theme should PUT it to the account');
  assert.equal(saveCall.url, '/api/me/theme');
  assert.deepEqual(JSON.parse(saveCall.body), { theme: 'cyber' });
});

test('theme.js: if saving to the account fails (offline, session hiccup), the theme still applies locally for this page view', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/board.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard' });
  dom.window.fetch = async () => {
    throw new Error('network down');
  };
  dom.window.eval(loadThemeJs());
  await new Promise((r) => setTimeout(r, 30));

  const doc = dom.window.document;
  doc.querySelector('.theme-picker-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  doc.querySelector('[data-theme="mesh"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(doc.body.classList.contains('theme-mesh'), 'a failed account save must not prevent the local/visual change from applying');
});
