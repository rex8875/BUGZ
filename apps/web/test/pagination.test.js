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

function makeReport(i) {
  return {
    id: `r${i}`, title: `Bug ${i}`, priority: 'LOW', status: 'NEW',
    reporter: { discordUsername: 'tester1' }, device: 'PC', createdAt: new Date().toISOString(),
    evidenceLink: null, f9Link: null,
  };
}

// A real, stateful paginated fake backend — pageSize 15, matching the
// real API — so requesting a given page returns the actually-correct
// slice, and the test can check both the request AND the render.
function statefulFetch(totalCount, { calledUrls } = {}) {
  const all = Array.from({ length: totalCount }, (_, i) => makeReport(i + 1));
  return async (url) => {
    if (calledUrls) calledUrls.push(String(url));
    if (String(url).includes('/me')) {
      return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'Alpha', iconUrl: null, backgroundStyle: null }) };
    }
    if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: totalCount }) };
    const u = new URL(String(url), 'https://example.test');
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
    const pageSize = 15;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const reports = all.slice((page - 1) * pageSize, page * pageSize);
    return { ok: true, status: 200, json: async () => ({ reports, page, totalPages, totalCount }) };
  };
}

test('15 or fewer reports: no Prev/Next nav, just the total count', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(12) });
  const doc = dom.window.document;

  assert.match(doc.getElementById('pagination').textContent, /12 reports/);
  assert.equal(doc.querySelector('[data-page-prev]'), null, 'a single page of results needs no Prev/Next controls');
  assert.equal(doc.querySelector('[data-page-next]'), null);
});

test('more than 15 reports: Prev/Next appear, Prev starts disabled, Next does not', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37) });
  const doc = dom.window.document;

  assert.match(doc.getElementById('pagination').textContent, /37 reports/);
  assert.match(doc.getElementById('pagination').textContent, /Page 1 of 3/);
  assert.equal(doc.querySelector('[data-page-prev]').disabled, true);
  assert.equal(doc.querySelector('[data-page-next]').disabled, false);
});

test('clicking Next requests page 2 and updates the indicator; clicking Prev goes back', async () => {
  const calledUrls = [];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37, { calledUrls }) });
  const doc = dom.window.document;

  calledUrls.length = 0;
  doc.querySelector('[data-page-next]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(calledUrls.some((u) => u.includes('page=2')), 'Next should request page 2');
  assert.match(doc.getElementById('pagination').textContent, /Page 2 of 3/);
  assert.equal(doc.querySelector('[data-page-prev]').disabled, false, 'Prev should now be enabled');

  calledUrls.length = 0;
  doc.querySelector('[data-page-prev]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calledUrls.some((u) => u.includes('page=1')), 'Prev should request page 1');
});

test('Next is disabled on the last page — cannot navigate past the end', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37) });
  const doc = dom.window.document;

  doc.querySelector('[data-page-next]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  doc.querySelector('[data-page-next]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.match(doc.getElementById('pagination').textContent, /Page 3 of 3/);
  assert.equal(doc.querySelector('[data-page-next]').disabled, true);
});

test('clicking the page number turns it into an editable field, same as title editing', async () => {
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37) });
  const doc = dom.window.document;

  doc.querySelector('[data-page-num]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.querySelector('.pagination-nav .inline-edit-field');
  assert.ok(field, 'clicking the page number should swap in a real input field, not open a popup');
  assert.equal(field.value, '1');
});

test('typing a valid page number and pressing Enter jumps straight to that page', async () => {
  const calledUrls = [];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37, { calledUrls }) });
  const doc = dom.window.document;

  doc.querySelector('[data-page-num]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.querySelector('.pagination-nav .inline-edit-field');
  field.value = '3';
  calledUrls.length = 0;
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(calledUrls.some((u) => u.includes('page=3')), 'should jump straight to page 3, no intermediate page clicks needed');
  assert.match(doc.getElementById('pagination').textContent, /Page 3 of 3/);
});

test('typing an out-of-range page number is rejected — no navigation happens, field stays open to retry', async () => {
  const calledUrls = [];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37, { calledUrls }) });
  const doc = dom.window.document;

  doc.querySelector('[data-page-num]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.querySelector('.pagination-nav .inline-edit-field');
  field.value = '99';
  calledUrls.length = 0;
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(calledUrls.some((u) => u.includes('/reports?')), false, 'an invalid page number must never trigger a request');
  const fieldAfter = doc.querySelector('.pagination-nav .inline-edit-field');
  assert.ok(fieldAfter, 'the field should stay open for retry, not revert to display text (same as an invalid title edit)');
  assert.equal(fieldAfter.value, '99', 'the typed value should still be there to correct, not cleared');
});

test('Escape while editing the page number cancels, no request sent, reverts to the display text', async () => {
  const calledUrls = [];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37, { calledUrls }) });
  const doc = dom.window.document;

  doc.querySelector('[data-page-num]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.querySelector('.pagination-nav .inline-edit-field');
  field.value = '2';
  calledUrls.length = 0;
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(calledUrls.length, 0, 'Escape must not trigger any request');
  assert.equal(doc.querySelector('.pagination-nav .inline-edit-field'), null, 'should revert back to plain display text');
  assert.match(doc.getElementById('pagination').textContent, /Page 1 of 3/);
});

test('changing a status filter resets to page 1, even when previously on a later page', async () => {
  const calledUrls = [];
  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl: statefulFetch(37, { calledUrls }) });
  const doc = dom.window.document;

  doc.querySelector('[data-page-next]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(doc.getElementById('pagination').textContent, /Page 2 of 3/);

  calledUrls.length = 0;
  doc.querySelector('#filters [data-status="FIXED"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const filterCall = calledUrls.find((u) => u.includes('status=FIXED'));
  assert.ok(filterCall, 'the filter change should have been sent');
  assert.match(filterCall, /page=1/, 'switching filters must reset back to page 1, not stay on page 2 of the old filter');
});

test('archiving the only report on the last page snaps back to a valid page instead of leaving a stale, empty one', async () => {
  // 16 reports, pageSize 15: page 1 has 15, page 2 has exactly 1 — the
  // report whose archiving is about to reduce the real total to 15,
  // which only fills page 1 (totalPages becomes 1).
  const totalReports = 16;
  let archivedIds = new Set();
  const all = Array.from({ length: totalReports }, (_, i) => ({ ...makeReport(i + 1), status: 'FIXED' }));

  const calledUrls = [];
  const fetchImpl = async (url, options = {}) => {
    calledUrls.push(String(url));
    if (String(url).includes('/me')) {
      return { ok: true, status: 200, json: async () => ({ permissions: { canManageBugs: true, canArchive: true }, retestChannelId: null, testerPingRoleId: null, serverName: 'Alpha', iconUrl: null, backgroundStyle: null }) };
    }
    const archiveMatch = String(url).match(/\/reports\/(r\d+)\/archive$/);
    if (archiveMatch && options.method === 'POST') {
      archivedIds.add(archiveMatch[1]);
      const report = all.find((r) => r.id === archiveMatch[1]);
      return { ok: true, status: 200, json: async () => ({ ...report, archivedAt: new Date().toISOString() }) };
    }
    if (String(url).includes('/summary')) return { ok: true, status: 200, json: async () => ({ total: totalReports - archivedIds.size }) };
    const visible = all.filter((r) => !archivedIds.has(r.id));
    const u = new URL(String(url), 'https://example.test');
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
    const pageSize = 15;
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    const clampedPage = Math.min(page, totalPages);
    const reports = visible.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);
    return { ok: true, status: 200, json: async () => ({ reports, page: clampedPage, totalPages, totalCount: visible.length }) };
  };

  const dom = await renderPage({ htmlFile: 'board.html', scripts: ['board.js'], fetchImpl });
  const doc = dom.window.document;

  doc.querySelector('[data-page-next]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(doc.getElementById('pagination').textContent, /Page 2 of 2/);
  assert.equal(doc.querySelectorAll('.report-row').length, 1, 'sanity check: page 2 has exactly the one report');

  const lastReportId = all[15].id;
  doc.querySelector(`.report-row[data-report-id="${lastReportId}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  calledUrls.length = 0;
  doc.querySelector(`.quick-actions[data-report-id="${lastReportId}"] [data-action="archive"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(calledUrls.some((u) => u.includes('/archive')), 'sanity check: the archive request was actually sent');
  assert.ok(calledUrls.some((u) => u.includes('page=2')), 'the reload should still try page 2 first, matching where the user was');
  assert.match(doc.getElementById('pagination').textContent, /15 reports/, 'the count should drop to 15, not stay stale at 16');
  assert.equal(doc.querySelector('[data-page-prev]'), null, 'down to a single page — the nav controls should disappear entirely, same as any other single-page view');
  assert.equal(doc.querySelectorAll('.report-row').length, 15, 'page 1\'s reports should now be visible instead of an empty list');
});
