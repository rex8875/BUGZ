const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function mockFetchSequence(responses) {
  let i = 0;
  return async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, status: 200, json: async () => body };
  };
}

// Loads a real public/*.html + its script(s) into jsdom, with fetch mocked,
// and lets the script's own async load() function run to completion before
// handing back the document for assertions.
async function renderPage({ htmlFile, scripts, fetchImpl, url = 'https://example.test/dashboard' }) {
  const html = fs.readFileSync(path.join(__dirname, '../public', htmlFile), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  dom.window.fetch = fetchImpl;
  for (const script of scripts) {
    const code = fs.readFileSync(path.join(__dirname, '../public', script), 'utf8');
    dom.window.eval(code);
  }
  // Allow any pending microtasks (the async load functions) to flush.
  await new Promise((resolve) => setTimeout(resolve, 60));
  return dom;
}

test('servers.html renders server cards with avatars (icon or initials fallback) and Customize buttons', async () => {
  const dom = await renderPage({
    htmlFile: 'servers.html',
    scripts: ['colorPicker.js', 'servers.js'],
    fetchImpl: mockFetchSequence([
      [
        { id: 's1', name: 'Alpha Testers', iconUrl: 'https://cdn.discordapp.com/icons/g1/abc.png', backgroundStyle: null, permissions: { canManageBugs: true, canManageSettings: true } },
        { id: 's2', name: 'Beta Crew', iconUrl: null, backgroundStyle: '#2d3a66', permissions: { canManageBugs: false, canManageSettings: false } },
      ],
    ]),
  });
  const doc = dom.window.document;

  const cards = doc.querySelectorAll('.server-card');
  assert.equal(cards.length, 2, 'both servers should render as cards');

  // Server with a real Discord icon should render an <img>, not initials.
  const imgAvatar = doc.querySelector('img.server-avatar');
  assert.ok(imgAvatar, 'server with an iconUrl should render an <img> avatar');
  assert.equal(imgAvatar.getAttribute('src'), 'https://cdn.discordapp.com/icons/g1/abc.png');

  // Server without an icon should fall back to initials, not a broken image.
  const initialsAvatar = [...doc.querySelectorAll('div.server-avatar')].find((el) => el.textContent.trim().length > 0);
  assert.ok(initialsAvatar, 'server without an iconUrl should fall back to an initials badge');
  assert.equal(initialsAvatar.textContent.trim(), 'BC');

  // Only the server the user can manage settings for gets a Customize button.
  const customizeButtons = doc.querySelectorAll('.server-customize-btn');
  assert.equal(customizeButtons.length, 1, 'only canManageSettings servers should show Customize');

  // Server with a saved background color should have it applied inline.
  const betaCard = [...cards].find((c) => c.textContent.includes('Beta Crew'));
  assert.match(betaCard.getAttribute('style') || '', /#2d3a66/);
});

test('board.html renders explicitly labeled, colored Priority and Status tags on each report row', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['board.js'],
    fetchImpl: mockFetchSequence([
      { permissions: { canManageBugs: true, canManageSettings: true, canManageRoles: true, canPingTesters: true, canArchive: true, canEditReports: true, canDeleteReports: true, canShareDashboard: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'Alpha Testers', iconUrl: null, backgroundStyle: null },
      { total: 1, NEW: 1 },
      [
        {
          id: 'r1', title: 'Floor breaks on level 3', priority: 'CRITICAL', status: 'NEW',
          reporter: { discordUsername: 'tester1' }, device: 'PC', createdAt: new Date().toISOString(),
          evidenceLink: 'https://example.com/clip.mp4', f9Link: 'https://example.com/f9.png',
        },
      ],
    ]),
  });
  const doc = dom.window.document;

  const row = doc.querySelector('.report-row');
  assert.ok(row, 'a report row should render');

  const priorityTag = row.querySelector('.tag-priority-CRITICAL');
  assert.ok(priorityTag, 'priority tag with the correct color class should render');
  assert.match(priorityTag.textContent, /Priority:/, 'priority tag must be explicitly labeled "Priority:"');
  assert.match(priorityTag.textContent, /Critical/);

  const statusTag = row.querySelector('.tag-status-NEW');
  assert.ok(statusTag, 'status tag with the correct color class should render');
  assert.match(statusTag.textContent, /Status:/, 'status tag must be explicitly labeled "Status:"');

  // Filter groups should be explicitly labeled too.
  assert.match(doc.getElementById('filters').textContent, /Status/);
  assert.match(doc.getElementById('priority-filters').textContent, /Priority/);

  // Server avatar element should exist in the topbar (even with no icon set,
  // it gets replaced with an initials fallback rather than staying broken).
  assert.ok(doc.querySelector('.server-avatar'), 'board topbar should show a server avatar (icon or initials)');
});

test('board.html opens directly to a specific report when linked via ?report=<id> (the retest message link target)', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['board.js'],
    url: 'https://example.test/dashboard/server-9?report=deep-linked-report',
    fetchImpl: async (url) => {
      if (String(url).includes('/reports/deep-linked-report')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'deep-linked-report', title: 'Deep linked bug', priority: 'HIGH', status: 'NEW',
            reporter: { discordUsername: 'tester1' }, device: 'PC', createdAt: new Date().toISOString(),
            evidenceLink: null, f9Link: null,
          }),
        };
      }
      if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: 0 }) };
      if (String(url).includes('/me')) {
        return {
          ok: true, status: 200,
          json: async () => ({ permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'Alpha', iconUrl: null, backgroundStyle: null }),
        };
      }
      // /reports (the general list) — deliberately empty, so this test
      // proves the deep link works even when the report isn't in the
      // currently-loaded filtered list (e.g. a different status).
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  const doc = dom.window.document;

  const detailPanel = doc.querySelector('#detail-area .detail-panel');
  assert.ok(detailPanel, 'the linked report should open directly in the detail panel on load');
  assert.match(detailPanel.textContent, /Deep linked bug/);
});

test('board.html shows the raw evidence/F9 URL as visible text, not a generic "View" link', async () => {
  const dom = await renderPage({
    htmlFile: 'board.html',
    scripts: ['board.js'],
    fetchImpl: mockFetchSequence([
      { permissions: { canManageBugs: true, canEditReports: true, canDeleteReports: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'Alpha', iconUrl: null, backgroundStyle: null },
      { total: 1, NEW: 1 },
      [
        {
          id: 'r1', title: 'Bug', priority: 'LOW', status: 'NEW',
          reporter: { discordUsername: 'tester1' }, device: 'PC', createdAt: new Date().toISOString(),
          evidenceLink: 'https://example.com/my-clip-evidence', f9Link: null,
        },
      ],
    ]),
  });
  const doc = dom.window.document;

  // Double-click to expand into the detail panel, same as a real user would.
  const row = doc.querySelector('.report-row');
  row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const link = doc.querySelector('a.raw-link');
  assert.ok(link, 'evidence link should render with the raw-link class');
  assert.equal(link.textContent.trim(), 'https://example.com/my-clip-evidence', 'the visible text must be the actual raw URL');
  assert.equal(/View/.test(link.textContent), false, 'must not use the old generic "View ↗" label');
});
