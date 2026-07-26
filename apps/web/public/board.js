const serverId = window.location.pathname.split('/').pop();

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const STATUSES = ['NEW', 'NEEDS_INFO', 'FIXED', 'NOT_A_BUG', 'DUPLICATE', 'WONT_FIX'];
const TERMINAL = ['FIXED', 'NOT_A_BUG', 'DUPLICATE', 'WONT_FIX'];
const LABELS = {
  NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug',
  DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix",
  LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical',
};

const state = {
  permissions: null,
  retestChannelId: null,
  testerPingRoleId: null,
  reports: [],
  selectedId: null,
  expandedId: null,
  filter: { status: null, priority: null, archived: false, search: null, before: null, on: null, after: null, byUsername: null, device: null },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (res.status === 401) {
    window.location.href = '/auth/discord';
    throw new Error('Not signed in');
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

function showError(message) {
  const el = document.getElementById('error');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
  if (message) {
    el.classList.remove('animate__animated', 'animate__headShake');
    void el.offsetWidth; // force reflow so the animation replays even for back-to-back errors
    el.classList.add('animate__animated', 'animate__headShake');
  }
}

async function load() {
  try {
    const me = await api(`/api/servers/${serverId}/me`);
    state.permissions = me.permissions;
    state.retestChannelId = me.retestChannelId;
    state.testerPingRoleId = me.testerPingRoleId;
    document.getElementById('server-name').textContent = me.serverName || 'Bug dashboard';
    const avatarEl = document.getElementById('server-avatar');
    if (me.iconUrl) {
      avatarEl.src = me.iconUrl;
      avatarEl.style.display = 'inline-block';
    } else if (me.serverName) {
      // No Discord icon set — fall back to an initials badge, same
      // treatment as the server picker cards use.
      const initials = me.serverName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join('');
      const fallback = document.createElement('div');
      fallback.className = 'server-avatar';
      fallback.style.width = '38px';
      fallback.style.height = '38px';
      fallback.style.fontSize = '13px';
      fallback.textContent = initials;
      avatarEl.replaceWith(fallback);
    }
    if (me.backgroundStyle) {
      if (me.backgroundStyle.startsWith('linear-gradient')) {
        document.body.style.backgroundImage = `${me.backgroundStyle}, ${getComputedStyle(document.body).backgroundImage}`;
      } else {
        document.body.style.backgroundColor = me.backgroundStyle;
      }
    }
    document.getElementById('leaderboard-link').href = `/dashboard/${serverId}/leaderboard`;
    if (state.permissions.canManageSettings || state.permissions.canShareDashboard) {
      document.getElementById('settings-btn').style.display = 'inline-block';
    }
    if (state.permissions.canManageRoles) {
      const rolesLink = document.getElementById('roles-link');
      rolesLink.href = `/dashboard/${serverId}/roles`;
      rolesLink.style.display = 'inline-block';
    }
    await loadSummary();
    await loadReports();
    await openDeepLinkedReportIfAny();
  } catch (err) {
    showError(err.message);
  }
}

// Supports links like /dashboard/:serverId?report=abc123 (used by the
// "Triggered by" retest messages) — opens straight to that report's
// detail panel even if it's archived or outside the current filter.
async function openDeepLinkedReportIfAny() {
  const reportId = new URLSearchParams(window.location.search).get('report');
  if (!reportId) return;

  try {
    const report = await api(`/api/servers/${serverId}/reports/${reportId}`);
    if (!state.reports.some((r) => r.id === report.id)) {
      state.reports = [report, ...state.reports];
    }
    state.selectedId = report.id;
    state.expandedId = report.id;
    renderList();
    renderDetail();
    document.getElementById('detail-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(`Couldn't open the linked report: ${err.message}`);
  }
}

async function loadSummary() {
  const summary = await api(`/api/servers/${serverId}/summary`);
  const labels = { NEW: 'New', NEEDS_INFO: 'Needs info', FIXED: 'Fixed', NOT_A_BUG: 'Not a bug', DUPLICATE: 'Duplicate', WONT_FIX: "Won't fix" };
  const parts = [`${summary.total} active`];
  for (const key of Object.keys(labels)) {
    if (summary[key]) parts.push(`${summary[key]} ${labels[key].toLowerCase()}`);
  }
  document.getElementById('summary-strip').textContent = parts.join(' · ');
}

// Parses "basement before:2024-01-01 by:alice" into structured filters.
// Anything not matching a known key:value token is treated as free text
// and matched against title/description server-side. Recognized keys:
// before, on, after (dates, YYYY-MM-DD), by (username substring),
// device. Unknown "word:value" tokens are left as-is in the free text
// (so a title that happens to contain a colon still searches sanely).
const SEARCH_TOKEN_KEYS = ['before', 'on', 'after', 'by', 'device'];

function parseSearchInput(raw) {
  const result = { search: null, before: null, on: null, after: null, byUsername: null, device: null };
  const leftoverWords = [];

  for (const word of raw.trim().split(/\s+/).filter(Boolean)) {
    const match = word.match(/^([a-zA-Z]+):(.+)$/);
    const key = match ? match[1].toLowerCase() : null;
    if (match && SEARCH_TOKEN_KEYS.includes(key)) {
      if (key === 'by') result.byUsername = match[2];
      else result[key] = match[2];
    } else {
      leftoverWords.push(word);
    }
  }

  result.search = leftoverWords.length > 0 ? leftoverWords.join(' ') : null;
  return result;
}

async function loadReports() {
  const params = new URLSearchParams();
  if (state.filter.status) params.set('status', state.filter.status);
  if (state.filter.priority) params.set('priority', state.filter.priority);
  params.set('archived', state.filter.archived ? 'true' : 'false');
  if (state.filter.search) params.set('search', state.filter.search);
  if (state.filter.before) params.set('before', state.filter.before);
  if (state.filter.on) params.set('on', state.filter.on);
  if (state.filter.after) params.set('after', state.filter.after);
  if (state.filter.byUsername) params.set('by', state.filter.byUsername);
  if (state.filter.device) params.set('device', state.filter.device);
  state.reports = await api(`/api/servers/${serverId}/reports?${params}`);
  renderFilters();
  renderList();
  renderDetail();
}

function renderFilters() {
  const tabs = [{ key: null, label: 'Active' }, ...STATUSES.map((s) => ({ key: s, label: LABELS[s] }))];
  document.getElementById('filters').innerHTML =
    `<div class="filter-group-label">Status</div><div class="filters">` +
    tabs
      .map(
        (t) =>
          `<div class="filter-pill ${state.filter.status === t.key && !state.filter.archived ? 'active' : ''}" data-status="${t.key || ''}">${t.label}</div>`,
      )
      .join('') +
    `<div class="filter-pill ${state.filter.archived ? 'active' : ''}" data-archived="1">Archived</div></div>`;

  document.getElementById('filters').querySelectorAll('[data-status]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filter.status = el.dataset.status || null;
      state.filter.archived = false;
      loadReports();
    });
  });
  document.querySelector('[data-archived]').addEventListener('click', () => {
    state.filter.archived = true;
    state.filter.status = null;
    loadReports();
  });

  const priorityTabs = [{ key: null, label: 'All priorities' }, ...PRIORITIES.map((p) => ({ key: p, label: LABELS[p] }))];
  document.getElementById('priority-filters').innerHTML =
    `<div class="filter-group-label">Priority</div><div class="filters">` +
    priorityTabs
      .map((t) => `<div class="filter-pill ${state.filter.priority === t.key ? 'active' : ''}" data-priority="${t.key || ''}">${t.label}</div>`)
      .join('') +
    `</div>`;

  document.getElementById('priority-filters').querySelectorAll('[data-priority]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filter.priority = el.dataset.priority || null;
      loadReports();
    });
  });
}

function priorityStatusTagsHtml(report) {
  return `
    <div class="tag-row">
      <span class="tag tag-priority-${report.priority}"><span class="tag-key">Priority:</span> ${LABELS[report.priority]}</span>
      <span class="tag tag-status-${report.status}"><span class="tag-key">Status:</span> ${LABELS[report.status]}</span>
    </div>`;
}

function quickActionsHtml(report) {
  if (!state.permissions.canManageBugs) return '';

  const priorityOptions = PRIORITIES.map((p) => `<option value="${p}" ${p === report.priority ? 'selected' : ''}>${LABELS[p]}</option>`).join('');
  const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === report.status ? 'selected' : ''}>${LABELS[s]}</option>`).join('');
  const canArchiveNow = state.permissions.canArchive && TERMINAL.includes(report.status);

  return `
    <div class="quick-actions" data-report-id="${report.id}">
      <select class="priority-select">${priorityOptions}</select>
      <select class="status-select">${statusOptions}</select>
      ${state.permissions.canPingTesters ? `<button data-action="ping">Ping testers</button>` : ''}
      ${state.permissions.canPingTesters ? `<button data-action="retest">Post in retested</button>` : ''}
      ${state.permissions.canArchive ? `<button data-action="archive" ${canArchiveNow ? '' : 'disabled'}>Archive</button>` : ''}
    </div>`;
}

function renderList() {
  const list = document.getElementById('report-list');
  if (state.reports.length === 0) {
    list.innerHTML = '<div class="hint">No reports here.</div>';
    return;
  }

  list.innerHTML = state.reports
    .map((r, i) => {
      const selected = r.id === state.selectedId;
      return `
        <div class="report-row animate__animated animate__fadeInUp animate__faster ${selected ? 'selected' : ''}" data-report-id="${r.id}" style="animation-delay:${Math.min(i, 12) * 35}ms">
          <div class="title">${escapeHtml(r.title)}</div>
          ${priorityStatusTagsHtml(r)}
          ${selected ? quickActionsHtml(r) : ''}
        </div>`;
    })
    .join('');

  list.querySelectorAll('.report-row').forEach((row) => {
    const id = row.dataset.reportId;
    row.addEventListener('click', (e) => {
      if (e.target.closest('select, button')) return;
      state.selectedId = id;
      renderList();
    });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('select, button')) return;
      state.selectedId = id;
      state.expandedId = id;
      renderList();
      renderDetail();
    });
  });

  list.querySelectorAll('.priority-select').forEach((sel) => {
    sel.addEventListener('change', (e) => updateReport(e.target.closest('[data-report-id]').dataset.reportId, { priority: sel.value }));
  });
  list.querySelectorAll('.status-select').forEach((sel) => {
    sel.addEventListener('change', (e) => updateReport(e.target.closest('[data-report-id]').dataset.reportId, { status: sel.value }));
  });
  list.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => runAction(e.target.closest('[data-report-id]').dataset.reportId, btn.dataset.action));
  });
}

function isSafeLinkUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function evidenceLinkHtml(fileUrl, link) {
  const url = fileUrl || link;
  if (!url) return '<span class="hint">None</span>';
  if (!isSafeLinkUrl(url)) {
    // Defense in depth: even if a non-http(s) value somehow made it into
    // the database (e.g. from before this validation existed), it is
    // shown as plain escaped text, never as a clickable href — escaping
    // alone does not stop a javascript: URL from executing on click.
    return `<span class="hint" title="This link isn't a valid http(s) URL, so it isn't clickable.">${escapeHtml(url)}</span>`;
  }
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="raw-link" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

function renderDetail() {
  const area = document.getElementById('detail-area');
  const report = state.reports.find((r) => r.id === state.expandedId);
  if (!report) {
    area.innerHTML = '';
    return;
  }

  area.innerHTML = `
    <div class="detail-panel animate__animated animate__fadeInDown animate__faster">
      <h2>${escapeHtml(report.title)} ${state.permissions.canEditReports ? '<button data-edit-title>Edit title</button>' : ''}</h2>
      <div class="detail-meta">reported by ${escapeHtml(report.reporter?.discordUsername || 'unknown')} · ${escapeHtml(report.device || 'unspecified device')} · ${new Date(report.createdAt).toLocaleDateString()}</div>
      <div class="detail-tags">${priorityStatusTagsHtml(report)}</div>

      <div class="detail-row"><div class="label">Description</div><div>${escapeHtml(report.description)} ${state.permissions.canEditReports ? '<button data-edit-description>Edit</button>' : ''}</div></div>
      ${report.stepsToReproduce ? `<div class="detail-row"><div class="label">Steps</div><div>${escapeHtml(report.stepsToReproduce)}</div></div>` : ''}
      <div class="detail-row"><div class="label">Evidence</div><div>${evidenceLinkHtml(report.evidenceFileUrl, report.evidenceLink)}</div></div>
      <div class="detail-row"><div class="label">F9</div><div>${evidenceLinkHtml(report.f9FileUrl, report.f9Link)}</div></div>
      ${report.additionalInfo ? `<div class="detail-row"><div class="label">Additional info</div><div>${escapeHtml(report.additionalInfo)}</div></div>` : ''}

      ${quickActionsHtml(report)}
      ${state.permissions.canPingTesters ? `<div class="posts-to">Posts to channel ${state.retestChannelId ? escapeHtml(state.retestChannelId) : '(not set — see Settings)'}</div>` : ''}
      ${state.permissions.canArchive ? `<div class="hint">Archive enables once status is Fixed, Not a bug, Duplicate, or Won't fix</div>` : ''}
      ${state.permissions.canDeleteReports ? `<div style="margin-top:12px;"><button data-delete-report>Delete permanently</button></div>` : ''}
    </div>`;

  const panel = area.querySelector('.detail-panel');
  panel.querySelectorAll('.priority-select').forEach((sel) => sel.addEventListener('change', () => updateReport(report.id, { priority: sel.value })));
  panel.querySelectorAll('.status-select').forEach((sel) => sel.addEventListener('change', () => updateReport(report.id, { status: sel.value })));
  panel.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', () => runAction(report.id, btn.dataset.action)));

  const editTitleBtn = panel.querySelector('[data-edit-title]');
  if (editTitleBtn) {
    editTitleBtn.addEventListener('click', () => {
      const next = prompt('New title', report.title);
      if (next && next.trim()) updateReport(report.id, { title: next.trim() });
    });
  }

  const editDescBtn = panel.querySelector('[data-edit-description]');
  if (editDescBtn) {
    editDescBtn.addEventListener('click', () => {
      const next = prompt('New description', report.description);
      if (next && next.trim()) updateReport(report.id, { description: next.trim() });
    });
  }

  const deleteBtn = panel.querySelector('[data-delete-report]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Permanently delete this report? This cannot be undone.')) return;
      try {
        await api(`/api/servers/${serverId}/reports/${report.id}`, { method: 'DELETE' });
        state.reports = state.reports.filter((r) => r.id !== report.id);
        state.expandedId = null;
        renderList();
        renderDetail();
        loadSummary();
      } catch (err) {
        showError(err.message);
      }
    });
  }
}

async function updateReport(id, data) {
  try {
    const updated = await api(`/api/servers/${serverId}/reports/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    state.reports = state.reports.map((r) => (r.id === id ? updated : r));
    renderList();
    renderDetail();
    if (data.status) loadSummary();
  } catch (err) {
    showError(err.message);
  }
}

async function runAction(id, action) {
  try {
    const updated = await api(`/api/servers/${serverId}/reports/${id}/${action}`, { method: 'POST' });
    state.reports = state.reports.map((r) => (r.id === id ? updated : r));
    renderList();
    renderDetail();
    if (action === 'archive') loadSummary();
  } catch (err) {
    showError(err.message);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Settings panel (retest channel + share links) ----

document.getElementById('settings-btn').addEventListener('click', async () => {
  const panel = document.getElementById('settings-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') await renderSettings();
});

async function renderSettings() {
  const panel = document.getElementById('settings-panel');
  const canSettings = state.permissions.canManageSettings;
  const canShare = state.permissions.canShareDashboard;

  panel.innerHTML = `
    ${
      canSettings
        ? `<h2>Settings</h2>
    <div class="field-group">
      <div>
        <label>Retest channel ID</label>
        <input type="text" id="retest-channel-input" value="${escapeHtml(state.retestChannelId || '')}" placeholder="Discord channel ID" />
        <button id="save-channel-btn">Save</button>
      </div>
      <div>
        <label>Tester role ID to ping</label>
        <input type="text" id="tester-role-input" value="${escapeHtml(state.testerPingRoleId || '')}" placeholder="Discord role ID" />
        <button id="save-tester-role-btn">Save</button>
      </div>
    </div>
    <div class="hint">Easier to set the role with <code>/set-tester-role</code> in Discord directly — this is a fallback for when you already have the ID.</div>`
        : ''
    }

    ${
      canShare
        ? `<h2 style="margin-top:20px;">Share links</h2>
    <div class="field-group">
      <select id="new-link-level"><option value="VIEW">View access</option><option value="DEV">Dev access</option></select>
      <input type="text" id="new-link-label" placeholder="Label (optional)" />
      <button id="create-link-btn" class="primary">Create link</button>
    </div>
    <div id="link-list"></div>`
        : ''
    }`;

  if (canSettings) {
    document.getElementById('save-channel-btn').addEventListener('click', async () => {
      try {
        await api(`/api/servers/${serverId}/settings`, {
          method: 'PATCH',
          body: JSON.stringify({ retestChannelId: document.getElementById('retest-channel-input').value }),
        });
        state.retestChannelId = document.getElementById('retest-channel-input').value;
      } catch (err) {
        showError(err.message);
      }
    });

    document.getElementById('save-tester-role-btn').addEventListener('click', async () => {
      try {
        await api(`/api/servers/${serverId}/settings`, {
          method: 'PATCH',
          body: JSON.stringify({ testerPingRoleId: document.getElementById('tester-role-input').value }),
        });
        state.testerPingRoleId = document.getElementById('tester-role-input').value;
      } catch (err) {
        showError(err.message);
      }
    });
  }

  if (canShare) {
    document.getElementById('create-link-btn').addEventListener('click', async () => {
      try {
        await api(`/api/servers/${serverId}/share-links`, {
          method: 'POST',
          body: JSON.stringify({
            accessLevel: document.getElementById('new-link-level').value,
            label: document.getElementById('new-link-label').value,
          }),
        });
        await renderSettings();
      } catch (err) {
        showError(err.message);
      }
    });

    renderLinkList(await api(`/api/servers/${serverId}/share-links`));
  }
}

function renderLinkList(links) {
  document.getElementById('link-list').innerHTML = links
    .map(
      (l) => `
      <div class="detail-row">
        <div class="label">${l.accessLevel === 'DEV' ? 'Dev' : 'View'}</div>
        <div>
          ${escapeHtml(l.label || '(no label)')} —
          ${l.revokedAt ? '<span class="hint">revoked</span>' : `<a href="${window.location.origin}/share/${l.id}">${window.location.origin}/share/${l.id}</a>`}
          · used by ${l.guestAccess.length} ${l.guestAccess.length === 1 ? 'person' : 'people'}
          ${!l.revokedAt ? `<button data-revoke="${l.id}">Revoke</button>` : ''}
        </div>
      </div>`,
    )
    .join('');

  document.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${serverId}/share-links/${btn.dataset.revoke}/revoke`, { method: 'POST' });
        await renderSettings();
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

function updateSearchHint() {
  const f = state.filter;
  const parts = [];
  if (f.search) parts.push(`text: "${f.search}"`);
  if (f.before) parts.push(`before ${f.before}`);
  if (f.on) parts.push(`on ${f.on}`);
  if (f.after) parts.push(`after ${f.after}`);
  if (f.byUsername) parts.push(`by ${f.byUsername}`);
  if (f.device) parts.push(`device ${f.device}`);
  document.getElementById('search-hint').textContent = parts.length > 0 ? `Searching: ${parts.join(' · ')}` : '';
}

function runSearch(rawValue) {
  const parsed = parseSearchInput(rawValue);
  Object.assign(state.filter, parsed);
  updateSearchHint();
  loadReports();
}

let searchDebounceTimer = null;
const searchInputEl = document.getElementById('search-input');
searchInputEl.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => runSearch(searchInputEl.value), 400);
});
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchDebounceTimer);
    runSearch(searchInputEl.value);
  }
});

load();
