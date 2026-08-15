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
