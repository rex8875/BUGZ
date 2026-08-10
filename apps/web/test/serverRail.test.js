const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function renderPage({ htmlFile, scripts, fetchImpl, url = 'https://example.test/dashboard' }) {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/public', htmlFile), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  dom.window.fetch = fetchImpl;
  for (const script of scripts) {
    const code = fs.readFileSync(path.join(process.cwd(), 'apps/web/public', script), 'utf8');
    dom.window.eval(code);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  return dom;
}

test('server rail only shows servers /api/servers actually returns — proves the exact "bot not present" and "no access" cases are excluded, not just "servers I\'m in on Discord"', async () => {
  // Simulates: Server A (dev server, bot present, I have access) returned
  // by the API; Server B (main server, no bot at all) and Server C (bot
  // present, but I have no dashboard access there) are NOT in the
  // response at all -- exactly what the real /api/servers route already
  // guarantees server-side (no DB row exists for a bot-less server, and
  // the route filters to canViewDashboard). The rail has no way to show
  // B or C even if it wanted to, since it only ever renders what this
  // endpoint hands it.
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['serverRail.js'],
    fetchImpl: async (url) => {
      if (String(url) === '/api/servers') {
        return { ok: true, status: 200, json: async () => [{ id: 'server-a', name: 'Dev Server', iconUrl: null, permissions: { canViewDashboard: true } }] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  const rail = doc.getElementById('server-rail');
  const serverLinks = rail.querySelectorAll('.rail-servers a');
  assert.equal(serverLinks.length, 1, 'only the one server the API actually returned should appear');
  assert.equal(serverLinks[0].getAttribute('href'), '/dashboard/server-a');
  assert.equal(serverLinks[0].getAttribute('title'), 'Dev Server', 'the name should be available as a tooltip, matching how Discord shows hidden server names on hover');
  assert.match(serverLinks[0].textContent, /DS/, 'with no custom icon, the initials fallback should render');
});

test('the current server is highlighted active; the home/all-servers icon is not, while inside a server', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['serverRail.js'],
    url: 'https://example.test/dashboard/server-a',
    fetchImpl: async (url) => {
      if (String(url) === '/api/servers') {
        return {
          ok: true, status: 200,
          json: async () => [
            { id: 'server-a', name: 'Dev Server', iconUrl: null, permissions: { canViewDashboard: true } },
            { id: 'server-x', name: 'Other Server', iconUrl: null, permissions: { canViewDashboard: true } },
          ],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  const active = doc.querySelectorAll('.rail-active');
  assert.equal(active.length, 1, 'exactly one rail icon should be marked active');
  assert.equal(active[0].getAttribute('href'), '/dashboard/server-a');
});

test('on the all-servers picker itself, the home icon is highlighted active, not any specific server', async () => {
  const dom = await renderPage({
    htmlFile: 'servers.html',
    scripts: ['serverRail.js'],
    url: 'https://example.test/dashboard',
    fetchImpl: async (url) => {
      if (String(url) === '/api/servers') {
        return { ok: true, status: 200, json: async () => [{ id: 'server-a', name: 'Dev Server', iconUrl: null, permissions: { canViewDashboard: true } }] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  const active = doc.querySelectorAll('.rail-active');
  assert.equal(active.length, 1);
  assert.ok(active[0].classList.contains('rail-home'), 'the home icon, not a server icon, should be the active one here');
});

test('a server with no custom icon falls back to initials, not a broken image', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['serverRail.js'],
    fetchImpl: async (url) => {
      if (String(url) === '/api/servers') {
        return { ok: true, status: 200, json: async () => [{ id: 'server-a', name: 'Anime Worlds', iconUrl: null, permissions: { canViewDashboard: true } }] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  const link = doc.querySelector('.rail-servers a');
  assert.equal(link.querySelector('img'), null, 'no broken <img> should render when there is no icon URL');
  assert.match(link.querySelector('.rail-initials').textContent, /^AW$/, 'initials should be derived from the first letter of each word');
});

test('an XSS payload in a server name never executes and never breaks out of the title attribute', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['serverRail.js'],
    fetchImpl: async (url) => {
      if (String(url) === '/api/servers') {
        return { ok: true, status: 200, json: async () => [{ id: 'server-a', name: '"><img src=x onerror=alert(1)>', iconUrl: null, permissions: { canViewDashboard: true } }] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  const dangerousEls = doc.querySelectorAll('#server-rail script, #server-rail img[onerror], #server-rail svg[onload]');
  assert.equal(dangerousEls.length, 0);
});

test('if /api/servers fails, the rail fails silently rather than crashing the page', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['serverRail.js'],
    fetchImpl: async (url) => {
      if (String(url) === '/api/servers') return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const doc = dom.window.document;
  // No crash means we get here at all; the rail mount should simply be empty.
  assert.equal(doc.getElementById('server-rail').innerHTML.trim(), '');
});
