const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function renderRolesPage({ fetchImpl }) {
  const html = fs.readFileSync(path.join(__dirname, '../public/roles.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/dashboard/server-9/roles' });
  dom.window.fetch = fetchImpl;
  dom.window.CSS = { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  for (const script of ['roles.js', 'commandPermissions.js']) {
    const code = fs.readFileSync(path.join(__dirname, '../public', script), 'utf8');
    dom.window.eval(code);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  return dom;
}

function mockFetch({ roles, commands, overrides }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/command-permissions/')) {
      const commandName = decodeURIComponent(String(url).split('/command-permissions/')[1]);
      const body = JSON.parse(options.body);
      overrides = { ...overrides };
      if (body.discordRoleIds.length > 0) overrides[commandName] = body.discordRoleIds;
      else delete overrides[commandName];
      return { ok: true, status: 200, json: async () => ({ commandName, discordRoleIds: body.discordRoleIds }) };
    }
    if (String(url).includes('/command-permissions')) {
      return { ok: true, status: 200, json: async () => ({ roles, commands, overrides }) };
    }
    // roles.js's other endpoints — empty/benign responses, not under test here.
    return { ok: true, status: 200, json: async () => [] };
  };
  impl.calls = calls;
  return impl;
}

const SAMPLE_ROLES = [
  { id: 'role-qa', name: 'QA Lead', color: 0xff0000 },
  { id: 'role-mod', name: 'Moderator', color: 0 },
];
const SAMPLE_COMMANDS = [
  { name: 'reset-score', description: "Reset someone's leaderboard score" },
  { name: 'take-role', description: 'Remove a role from someone' },
];

test('renders a summary line and a Default/Restricted status badge per command', async () => {
  const fetchImpl = mockFetch({ roles: SAMPLE_ROLES, commands: SAMPLE_COMMANDS, overrides: { 'reset-score': ['role-qa'] } });
  const dom = await renderRolesPage({ fetchImpl });
  const doc = dom.window.document;

  assert.match(doc.getElementById('cmd-perms-summary').textContent, /1 of 2/);

  const rows = doc.querySelectorAll('.cmd-row');
  assert.equal(rows.length, 2);

  const resetRow = [...rows].find((r) => r.dataset.cmd === 'reset-score');
  assert.match(resetRow.querySelector('.cmd-row-status').textContent, /Restricted to 1 role/);

  const takeRoleRow = [...rows].find((r) => r.dataset.cmd === 'take-role');
  assert.match(takeRoleRow.querySelector('.cmd-row-status').textContent, /Default/);
});

test('clicking a command row expands it to show real role names with their actual Discord colors as checkboxes', async () => {
  const fetchImpl = mockFetch({ roles: SAMPLE_ROLES, commands: SAMPLE_COMMANDS, overrides: {} });
  const dom = await renderRolesPage({ fetchImpl });
  const doc = dom.window.document;

  doc.querySelector('[data-toggle="reset-score"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const options = doc.querySelectorAll('.cmd-role-option');
  assert.equal(options.length, 2, 'should show one checkbox per real Discord role');
  assert.match(doc.getElementById('cmd-perms-list').textContent, /QA Lead/);
  assert.match(doc.getElementById('cmd-perms-list').textContent, /Moderator/);

  const qaDot = [...options].find((o) => o.textContent.includes('QA Lead')).querySelector('.cmd-role-dot');
  assert.equal(qaDot.style.background, 'rgb(255, 0, 0)', "QA Lead's dot should reflect its actual Discord color (0xff0000)");
});

test('checking a role and clicking Save sends the new override to the API', async () => {
  const fetchImpl = mockFetch({ roles: SAMPLE_ROLES, commands: SAMPLE_COMMANDS, overrides: {} });
  const dom = await renderRolesPage({ fetchImpl });
  const doc = dom.window.document;

  doc.querySelector('[data-toggle="reset-score"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const qaCheckbox = doc.querySelector('[data-role-checkbox="role-qa"]');
  qaCheckbox.checked = true;
  qaCheckbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  doc.querySelector('[data-save="reset-score"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const patchCall = fetchImpl.calls.find((c) => c.url.includes('/command-permissions/reset-score') && c.options?.method === 'PATCH');
  assert.ok(patchCall, 'a PATCH request should have been sent');
  assert.deepEqual(JSON.parse(patchCall.options.body).discordRoleIds, ['role-qa']);
});

test('"Reset to default" sends an empty role list, clearing the override', async () => {
  const fetchImpl = mockFetch({ roles: SAMPLE_ROLES, commands: SAMPLE_COMMANDS, overrides: { 'reset-score': ['role-qa'] } });
  const dom = await renderRolesPage({ fetchImpl });
  const doc = dom.window.document;

  doc.querySelector('[data-toggle="reset-score"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  doc.querySelector('[data-clear="reset-score"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const patchCall = fetchImpl.calls.find((c) => c.url.includes('/command-permissions/reset-score') && c.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(patchCall.options.body).discordRoleIds, []);
});

test('the search box filters the command list by name and description', async () => {
  const fetchImpl = mockFetch({ roles: SAMPLE_ROLES, commands: SAMPLE_COMMANDS, overrides: {} });
  const dom = await renderRolesPage({ fetchImpl });
  const doc = dom.window.document;

  const search = doc.getElementById('cmd-perms-search');
  search.value = 'leaderboard';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const rows = doc.querySelectorAll('.cmd-row');
  assert.equal(rows.length, 1, 'only reset-score matches "leaderboard" (in its description)');
  assert.equal(rows[0].dataset.cmd, 'reset-score');
});
