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
  reports: [],
  selectedId: null,
  expandedId: null,
  filter: { status: null, includeArchived: false },
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
}

async function load() {
  try {
    const me = await api(`/api/servers/${serverId}/me`);
    state.permissions = me.permissions;
    state.retestChannelId = me.retestChannelId;
    document.getElementById('server-name').textContent = 'Bug dashboard';
    if (state.permissions.canManageSettings) {
      document.getElementById('settings-btn').style.display = 'inline-block';
    }
    await loadReports();
  } catch (err) {
    showError(err.message);
  }
}

async function loadReports() {
  const params = new URLSearchParams();
  if (state.filter.status) params.set('status', state.filter.status);
  params.set('includeArchived', state.filter.includeArchived ? 'true' : 'false');
  state.reports = await api(`/api/servers/${serverId}/reports?${params}`);
  renderFilters();
  renderList();
  renderDetail();
}

function renderFilters() {
  const tabs = [{ key: null, label: 'Active' }, ...STATUSES.map((s) => ({ key: s, label: LABELS[s] }))];
  document.getElementById('filters').innerHTML =
    tabs
      .map(
        (t) =>
          `<div class="filter-pill ${state.filter.status === t.key && !state.filter.includeArchived ? 'active' : ''}" data-status="${t.key || ''}">${t.label}</div>`,
      )
      .join('') +
    `<div class="filter-pill ${state.filter.includeArchived ? 'active' : ''}" data-archived="1">Archived</div>`;

  document.getElementById('filters').querySelectorAll('[data-status]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filter.status = el.dataset.status || null;
      state.filter.includeArchived = false;
      loadReports();
    });
  });
  document.querySelector('[data-archived]').addEventListener('click', () => {
    state.filter.includeArchived = true;
    state.filter.status = null;
    loadReports();
  });
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
    .map((r) => {
      const selected = r.id === state.selectedId;
      return `
        <div class="report-row ${selected ? 'selected' : ''}" data-report-id="${r.id}">
          <div class="title">${escapeHtml(r.title)}</div>
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

function evidenceLinkHtml(fileUrl, link) {
  const url = fileUrl || link;
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">View ↗</a>` : '<span class="hint">None</span>';
}

function renderDetail() {
  const area = document.getElementById('detail-area');
  const report = state.reports.find((r) => r.id === state.expandedId);
  if (!report) {
    area.innerHTML = '';
    return;
  }

  area.innerHTML = `
    <div class="detail-panel">
      <h2>${escapeHtml(report.title)}</h2>
      <div class="detail-meta">reported by ${escapeHtml(report.reporter?.discordUsername || 'unknown')} · ${escapeHtml(report.device || 'unspecified device')} · ${new Date(report.createdAt).toLocaleDateString()}</div>

      <div class="detail-row"><div class="label">Description</div><div>${escapeHtml(report.description)}</div></div>
      ${report.stepsToReproduce ? `<div class="detail-row"><div class="label">Steps</div><div>${escapeHtml(report.stepsToReproduce)}</div></div>` : ''}
      <div class="detail-row"><div class="label">Evidence</div><div>${evidenceLinkHtml(report.evidenceFileUrl, report.evidenceLink)}</div></div>
      <div class="detail-row"><div class="label">F9</div><div>${evidenceLinkHtml(report.f9FileUrl, report.f9Link)}</div></div>
      ${report.additionalInfo ? `<div class="detail-row"><div class="label">Additional info</div><div>${escapeHtml(report.additionalInfo)}</div></div>` : ''}

      ${quickActionsHtml(report)}
      ${state.permissions.canPingTesters ? `<div class="posts-to">Posts to channel ${state.retestChannelId ? escapeHtml(state.retestChannelId) : '(not set — see Settings)'}</div>` : ''}
      ${state.permissions.canArchive ? `<div class="hint">Archive enables once status is Fixed, Not a bug, Duplicate, or Won't fix</div>` : ''}
    </div>`;

  const panel = area.querySelector('.detail-panel');
  panel.querySelectorAll('.priority-select').forEach((sel) => sel.addEventListener('change', () => updateReport(report.id, { priority: sel.value })));
  panel.querySelectorAll('.status-select').forEach((sel) => sel.addEventListener('change', () => updateReport(report.id, { status: sel.value })));
  panel.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', () => runAction(report.id, btn.dataset.action)));
}

async function updateReport(id, data) {
  try {
    const updated = await api(`/api/servers/${serverId}/reports/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    state.reports = state.reports.map((r) => (r.id === id ? updated : r));
    renderList();
    renderDetail();
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
  const links = await api(`/api/servers/${serverId}/share-links`);

  panel.innerHTML = `
    <h2>Settings</h2>
    <div class="field-group">
      <div>
        <label>Retest channel ID</label>
        <input type="text" id="retest-channel-input" value="${escapeHtml(state.retestChannelId || '')}" placeholder="Discord channel ID" />
        <button id="save-channel-btn">Save</button>
      </div>
    </div>

    <h2 style="margin-top:20px;">Share links</h2>
    <div class="field-group">
      <select id="new-link-level"><option value="VIEW">View access</option><option value="DEV">Dev access</option></select>
      <input type="text" id="new-link-label" placeholder="Label (optional)" />
      <button id="create-link-btn" class="primary">Create link</button>
    </div>
    <div id="link-list"></div>`;

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

  renderLinkList(links);
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

load();
