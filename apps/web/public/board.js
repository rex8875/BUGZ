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
  backgroundStyle: null,
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

// Lightweight success/info confirmation for actions that previously
// gave no visible feedback beyond a re-render — guarded so it's a
// harmless no-op wherever SweetAlert2 isn't loaded (e.g. tests).
function showToast(icon, title) {
  if (!window.Swal) return;
  window.Swal.fire({ toast: true, position: 'top-end', icon, title, showConfirmButton: false, timer: 2200, timerProgressBar: true });
}

// Real, styled confirm/prompt dialogs instead of the browser's native
// unstyled confirm()/prompt() (which can't be themed at all and look
// completely out of place next to the rest of the UI). Falls back to
// the native dialogs wherever SweetAlert2 isn't loaded, so this stays
// fully testable without depending on a network-loaded script.
async function confirmDialog({ title, text, confirmText = 'Confirm', danger = false }) {
  if (!window.Swal) return window.confirm(`${title}\n${text || ''}`);
  const result = await window.Swal.fire({
    title, text, icon: 'warning', showCancelButton: true,
    confirmButtonText: confirmText, cancelButtonText: 'Cancel',
    confirmButtonColor: danger ? '#e5484d' : undefined,
    reverseButtons: true,
  });
  return result.isConfirmed;
}

async function promptDialog({ title, initialValue = '' }) {
  if (!window.Swal) return window.prompt(title, initialValue);
  const result = await window.Swal.fire({
    title, input: 'text', inputValue: initialValue,
    showCancelButton: true, confirmButtonText: 'Save', cancelButtonText: 'Cancel',
    inputValidator: (value) => (!value || !value.trim() ? 'Cannot be empty' : undefined),
  });
  return result.isConfirmed ? result.value : null;
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
      state.backgroundStyle = me.backgroundStyle;
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
    if (state.permissions.canManageSettings) {
      document.getElementById('customize-btn').style.display = 'inline-block';
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
    document.querySelector(`.detail-panel[data-report-id="${report.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  if (state.expandedId && !state.reports.some((r) => r.id === state.expandedId)) state.expandedId = null;
  renderFilters();
  renderList();
}

function renderFilters() {
  const statusDot = (key) => (key ? `<span class="pill-dot pill-dot-status-${key}"></span>` : `<span class="pill-dot pill-dot-all"></span>`);
  const tabs = [{ key: null, label: 'Active' }, ...STATUSES.map((s) => ({ key: s, label: LABELS[s] }))];
  document.getElementById('filters').innerHTML =
    `<div class="filter-group-label">Status</div><div class="filters">` +
    tabs
      .map(
        (t) =>
          `<div class="filter-pill ${state.filter.status === t.key && !state.filter.archived ? 'active' : ''}" data-status="${t.key || ''}">${statusDot(t.key)}${t.label}</div>`,
      )
      .join('') +
    `<div class="filter-pill ${state.filter.archived ? 'active' : ''}" data-archived="1"><span class="pill-dot pill-dot-archived"></span>Archived</div></div>`;

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

  const priorityDot = (key) => `<span class="pill-dot ${key ? `pill-dot-priority-${key}` : 'pill-dot-all'}"></span>`;
  const priorityTabs = [{ key: null, label: 'All priorities' }, ...PRIORITIES.map((p) => ({ key: p, label: LABELS[p] }))];
  document.getElementById('priority-filters').innerHTML =
    `<div class="filter-group-label">Priority</div><div class="filters">` +
    priorityTabs
      .map((t) => `<div class="filter-pill ${state.filter.priority === t.key ? 'active' : ''}" data-priority="${t.key || ''}">${priorityDot(t.key)}${t.label}</div>`)
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
      <select class="status-select" ${report.archivedAt ? 'disabled title="Status is locked while archived — unarchive first"' : ''}>${statusOptions}</select>
      ${state.permissions.canPingTesters ? `<button data-action="ping">Ping testers</button>` : ''}
      ${state.permissions.canPingTesters ? `<button data-action="retest">Post in retested</button>` : ''}
      ${
        state.permissions.canArchive
          ? report.archivedAt
            ? `<button data-action="unarchive">Unarchive</button>`
            : `<button data-action="archive" ${canArchiveNow ? '' : 'disabled'}>Archive</button>`
          : ''
      }
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
      const expanded = r.id === state.expandedId;
      return `
        <div class="report-row report-row-priority-${r.priority} animate__animated animate__fadeInUp animate__faster ${selected ? 'selected' : ''} ${expanded ? 'expanded' : ''}" data-report-id="${r.id}" style="animation-delay:${Math.min(i, 12) * 35}ms">
          <div class="title">${escapeHtml(r.title)}</div>
          ${priorityStatusTagsHtml(r)}
          ${selected ? quickActionsHtml(r) : ''}
        </div>
        ${expanded ? detailPanelHtml(r) : ''}`;
    })
    .join('');

  list.querySelectorAll('.report-row').forEach((row) => {
    const id = row.dataset.reportId;
    row.addEventListener('click', (e) => {
      if (e.target.closest('select, button, a, input')) return;
      if (state.expandedId === id) return; // already fully open — use the × to close it
      if (state.selectedId === id) {
        // second click on the already-quick-viewed row -> open the full view
        state.expandedId = id;
      } else {
        // first click on this row -> quick view only, collapsing any other
        // report's full view that might currently be open
        state.selectedId = id;
        state.expandedId = null;
      }
      renderList();
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

  bindDetailPanelEvents();
  if (window.lucide) window.lucide.createIcons();
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

function detailPanelHtml(report) {
  return `
    <div class="detail-panel animate__animated animate__fadeInDown animate__faster" data-report-id="${report.id}">
      <button class="detail-close" data-close-detail title="Close" aria-label="Close detail view"><i data-lucide="x"></i></button>
      <h2 class="detail-title-row">
        <span class="detail-title-text" data-title-text>${escapeHtml(report.title)}</span>
        ${state.permissions.canEditReports ? '<button data-edit-title><i data-lucide="pencil"></i> Edit title</button>' : ''}
      </h2>
      <div class="detail-meta"><i data-lucide="user"></i> reported by ${escapeHtml(report.reporter?.discordUsername || 'unknown')} · ${escapeHtml(report.device || 'unspecified device')} · ${new Date(report.createdAt).toLocaleDateString()}</div>
      <div class="detail-tags">${priorityStatusTagsHtml(report)}</div>

      <div class="detail-row">
        <div class="label">Description</div>
        <div class="detail-desc-row">
          <span class="detail-desc-text" data-desc-text>${escapeHtml(report.description)}</span>
          ${state.permissions.canEditReports ? '<button data-edit-description><i data-lucide="pencil"></i> Edit</button>' : ''}
        </div>
      </div>
      ${report.stepsToReproduce ? `<div class="detail-row"><div class="label">Steps</div><div>${escapeHtml(report.stepsToReproduce)}</div></div>` : ''}
      <div class="detail-row"><div class="label">Evidence</div><div>${evidenceLinkHtml(report.evidenceFileUrl, report.evidenceLink)}</div></div>
      <div class="detail-row"><div class="label">F9</div><div>${evidenceLinkHtml(report.f9FileUrl, report.f9Link)}</div></div>
      ${report.additionalInfo ? `<div class="detail-row"><div class="label">Additional info</div><div>${escapeHtml(report.additionalInfo)}</div></div>` : ''}

      ${quickActionsHtml(report)}
      ${state.permissions.canPingTesters ? `<div class="posts-to">Posts to channel ${state.retestChannelId ? escapeHtml(state.retestChannelId) : '(not set — see Settings)'}</div>` : ''}
      ${state.permissions.canArchive && !report.archivedAt ? `<div class="hint">Archive enables once status is Fixed, Not a bug, Duplicate, or Won't fix</div>` : ''}
      ${state.permissions.canDeleteReports ? `<div style="margin-top:12px;"><button data-delete-report><i data-lucide="trash-2"></i> Delete permanently</button></div>` : ''}
    </div>`;
}

// Turns a title/description into an in-place text field instead of a
// popup dialog. Escape cancels; Enter saves (Ctrl/Cmd+Enter for
// multiline, so plain Enter can still insert a newline); clicking away
// also saves, same as most inline-edit UIs.
function startInlineEdit({ textEl, currentValue, onSave, multiline = false }) {
  const field = document.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) field.type = 'text';
  else field.rows = 3;
  field.className = 'inline-edit-field';
  field.value = currentValue;

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const next = field.value.trim();
      if (next && next !== currentValue) {
        field.disabled = true;
        try {
          await onSave(next);
        } catch {
          done = false;
          field.disabled = false;
          field.focus();
          return;
        }
      }
    }
    field.replaceWith(textEl);
  };

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish(true);
    }
  });
  field.addEventListener('blur', () => finish(true));

  textEl.replaceWith(field);
  field.focus();
  if (!multiline) field.select();
}

function bindDetailPanelEvents() {
  const panel = document.querySelector('#report-list .detail-panel');
  if (!panel) return;
  const reportId = panel.dataset.reportId;
  const report = state.reports.find((r) => r.id === reportId);
  if (!report) return;

  // Note: .priority-select, .status-select, and [data-action] inside this
  // panel are NOT bound here — the general loop in renderList() already
  // covers every element of those kinds in #report-list, and the detail
  // panel is a descendant of it. Binding them again here was firing every
  // one of those twice per click/change.

  panel.querySelector('[data-close-detail]').addEventListener('click', () => {
    state.expandedId = null;
    renderList();
  });

  const editTitleBtn = panel.querySelector('[data-edit-title]');
  if (editTitleBtn) {
    editTitleBtn.addEventListener('click', () => {
      startInlineEdit({
        textEl: panel.querySelector('[data-title-text]'),
        currentValue: report.title,
        onSave: async (next) => {
          await updateReport(report.id, { title: next });
          showToast('success', 'Title updated');
        },
      });
    });
  }

  const editDescBtn = panel.querySelector('[data-edit-description]');
  if (editDescBtn) {
    editDescBtn.addEventListener('click', () => {
      startInlineEdit({
        textEl: panel.querySelector('[data-desc-text]'),
        currentValue: report.description,
        multiline: true,
        onSave: async (next) => {
          await updateReport(report.id, { description: next });
          showToast('success', 'Description updated');
        },
      });
    });
  }

  const deleteBtn = panel.querySelector('[data-delete-report]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Delete this report?',
        text: 'This cannot be undone.',
        confirmText: 'Delete permanently',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/api/servers/${serverId}/reports/${report.id}`, { method: 'DELETE' });
        state.reports = state.reports.filter((r) => r.id !== report.id);
        state.expandedId = null;
        renderList();
        loadSummary();
        showToast('success', 'Report deleted');
      } catch (err) {
        showError(err.message);
      }
    });
  }
}

// Swaps an updated report into state.reports, unless it no longer matches
// the current filter (e.g. archiving it while viewing Active, unarchiving
// while viewing Archived, or changing status away from the status tab
// currently selected) — in which case it's removed from view instead of
// lingering with stale data until the next full reload.
function reconcileUpdatedReport(updated) {
  const stillMatchesFilter =
    (state.filter.archived ? !!updated.archivedAt : !updated.archivedAt) &&
    (!state.filter.status || updated.status === state.filter.status) &&
    (!state.filter.priority || updated.priority === state.filter.priority);

  if (stillMatchesFilter) {
    state.reports = state.reports.map((r) => (r.id === updated.id ? updated : r));
  } else {
    state.reports = state.reports.filter((r) => r.id !== updated.id);
    if (state.selectedId === updated.id) state.selectedId = null;
    if (state.expandedId === updated.id) state.expandedId = null;
  }
}

async function updateReport(id, data) {
  try {
    const updated = await api(`/api/servers/${serverId}/reports/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    reconcileUpdatedReport(updated);
    renderList();
    if (data.status) loadSummary();
  } catch (err) {
    showError(err.message);
  }
}

const ACTION_TOAST = { ping: 'Testers pinged', retest: 'Posted to retest channel', archive: 'Report archived', unarchive: 'Report unarchived' };

async function runAction(id, action) {
  try {
    const updated = await api(`/api/servers/${serverId}/reports/${id}/${action}`, { method: 'POST' });
    reconcileUpdatedReport(updated);
    renderList();
    if (action === 'archive' || action === 'unarchive') loadSummary();
    if (ACTION_TOAST[action]) showToast('success', ACTION_TOAST[action]);
  } catch (err) {
    showError(err.message);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Customize (per-server background — same picker used on the servers list page) ----

document.getElementById('customize-btn').addEventListener('click', () => {
  const panel = document.getElementById('customize-panel');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) renderCustomizePanel();
});

function renderCustomizePanel() {
  const panel = document.getElementById('customize-panel');
  panel.innerHTML = `
    <div class="appearance-panel animate__animated animate__fadeInDown animate__faster">
      <h3><i data-lucide="palette"></i> Background</h3>
      <div id="picker-mount"></div>
      <div class="quick-actions" style="border:none;margin-top:14px;padding-top:0;">
        <button class="primary" id="save-appearance-btn"><i data-lucide="check"></i> Save background</button>
        <button id="clear-appearance-btn"><i data-lucide="rotate-ccw"></i> Reset to default</button>
        <span class="hint" id="appearance-error"></span>
      </div>
    </div>`;
  if (window.lucide) window.lucide.createIcons();

  const picker = window.FieldLogColorPicker.createAppearancePicker({
    container: document.getElementById('picker-mount'),
    initialValue: state.backgroundStyle,
  });

  document.getElementById('save-appearance-btn').addEventListener('click', async (e) => {
    try {
      const updated = await api(`/api/servers/${serverId}/appearance`, {
        method: 'PATCH',
        body: JSON.stringify({ backgroundStyle: picker.getValue() }),
      });
      state.backgroundStyle = updated.backgroundStyle;
      e.target.classList.add('save-success');
      e.target.textContent = 'Saved ✓';
      setTimeout(() => window.location.reload(), 420); // simplest correct way to re-apply the new body background everywhere it's used
    } catch (err) {
      document.getElementById('appearance-error').textContent = err.message;
    }
  });

  document.getElementById('clear-appearance-btn').addEventListener('click', async () => {
    try {
      await api(`/api/servers/${serverId}/appearance`, { method: 'PATCH', body: JSON.stringify({ backgroundStyle: null }) });
      window.location.reload();
    } catch (err) {
      document.getElementById('appearance-error').textContent = err.message;
    }
  });
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
        <button id="save-channel-btn"><i data-lucide="check"></i> Save</button>
      </div>
      <div>
        <label>Tester role ID to ping</label>
        <input type="text" id="tester-role-input" value="${escapeHtml(state.testerPingRoleId || '')}" placeholder="Discord role ID" />
        <button id="save-tester-role-btn"><i data-lucide="check"></i> Save</button>
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
      <button id="create-link-btn" class="primary"><i data-lucide="link"></i> Create link</button>
    </div>
    <div id="link-list"></div>`
        : ''
    }`;

  if (window.lucide) window.lucide.createIcons();

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
        showToast('success', 'Share link created');
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
          ${!l.revokedAt ? `<button data-revoke="${l.id}"><i data-lucide="ban"></i> Revoke</button>` : ''}
        </div>
      </div>`,
    )
    .join('');
  if (window.lucide) window.lucide.createIcons();

  document.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${serverId}/share-links/${btn.dataset.revoke}/revoke`, { method: 'POST' });
        await renderSettings();
        showToast('success', 'Share link revoked');
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
  updateSuggestions();
});
searchInputEl.addEventListener('click', updateSuggestions);
searchInputEl.addEventListener('keydown', (e) => {
  if (handleSuggestKeydown(e)) return; // suggestion list consumed the key (nav/select/close)
  if (e.key === 'Enter') {
    clearTimeout(searchDebounceTimer);
    runSearch(searchInputEl.value);
  }
});
searchInputEl.addEventListener('blur', () => {
  // Delay so a click on a suggestion (which also blurs the input) still registers.
  setTimeout(() => hideSuggestions(), 150);
});

// ---- Search autocomplete: filter-key suggestions, live username
// matches for by:, known device values for device:, and a real date
// picker (Flatpickr) for before:/on:/after: — the "help me while I
// type" affordance Discord's own search box has. ----

const SEARCH_TOKEN_HELP = {
  before: 'Reports created before a date',
  on: 'Reports created on a specific date',
  after: 'Reports created after a date',
  by: 'Reports from a specific person',
  device: 'Filter by device',
};
const SEARCH_TOKEN_EXAMPLE = { before: 'date', on: 'date', after: 'date', by: 'username', device: 'PC' };
const DEVICE_VALUES = ['PC', 'Mobile', 'Tablet', 'Console'];
const DATE_KEYS = ['before', 'on', 'after'];
let suggestIndex = -1;
let datePickerToken = null; // the token {start,end} a chosen date should be spliced into
let flatpickrInstance = null;

function getCurrentToken(value, cursorPos) {
  const start = value.lastIndexOf(' ', cursorPos - 1) + 1;
  let end = value.indexOf(' ', cursorPos);
  if (end === -1) end = value.length;
  return { text: value.slice(start, end), start, end };
}

function replaceToken(token, replacement) {
  const value = searchInputEl.value;
  const next = value.slice(0, token.start) + replacement + value.slice(token.end);
  searchInputEl.value = next;
  const cursor = token.start + replacement.length;
  searchInputEl.setSelectionRange(cursor, cursor);
  searchInputEl.focus();
  clearTimeout(searchDebounceTimer);
  runSearch(next);
}

function ensureDatePicker() {
  if (flatpickrInstance || !window.flatpickr) return flatpickrInstance;
  const anchor = document.createElement('input');
  anchor.type = 'text';
  anchor.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
  document.getElementById('search-input').insertAdjacentElement('afterend', anchor);
  flatpickrInstance = window.flatpickr(anchor, {
    onChange: (dates) => {
      if (!dates[0] || !datePickerToken) return;
      const d = dates[0];
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const key = datePickerToken.text.split(':')[0];
      replaceToken(datePickerToken, `${key}:${iso}`);
      hideSuggestions();
    },
  });
  return flatpickrInstance;
}

function suggestionItemsFor(token) {
  const colonIdx = token.text.indexOf(':');
  if (colonIdx === -1) {
    const prefix = token.text.toLowerCase();
    return SEARCH_TOKEN_KEYS.filter((k) => k.startsWith(prefix)).map((k) => ({
      icon: DATE_KEYS.includes(k) ? 'calendar' : k === 'by' ? 'user' : 'monitor-smartphone',
      label: SEARCH_TOKEN_HELP[k],
      sub: `${k}: ${SEARCH_TOKEN_EXAMPLE[k]}`,
      apply: () => replaceToken(token, `${k}:`),
    }));
  }

  const key = token.text.slice(0, colonIdx).toLowerCase();
  const partial = token.text.slice(colonIdx + 1).toLowerCase();
  if (!SEARCH_TOKEN_KEYS.includes(key)) return [];

  if (DATE_KEYS.includes(key)) {
    return [{
      icon: 'calendar', label: 'Pick a date…', sub: 'Opens a calendar',
      apply: () => {
        datePickerToken = token;
        // Deferred a tick: opening synchronously here races Flatpickr's own
        // document-level "click outside closes the calendar" listener. This
        // apply() runs from a mousedown on a suggestion item, and that same
        // mousedown keeps bubbling up to document right after we open —
        // since the click target isn't the calendar or its input, Flatpickr
        // immediately closes what it just opened. Pushing the open() call
        // to the next tick lets the original mousedown finish bubbling
        // first. (Tabbing to the hidden anchor input worked around this
        // before, since a focus event doesn't bubble through this same
        // mousedown chain.)
        setTimeout(() => { const fp = ensureDatePicker(); if (fp) fp.open(); }, 0);
      },
    }];
  }
  if (key === 'device') {
    return DEVICE_VALUES.filter((d) => d.toLowerCase().includes(partial)).map((d) => ({
      icon: 'monitor-smartphone', label: d, apply: () => replaceToken(token, `device:${d}`),
    }));
  }
  if (key === 'by') {
    const usernames = [...new Set(state.reports.map((r) => r.reporter?.discordUsername).filter(Boolean))];
    return usernames
      .filter((u) => u.toLowerCase().includes(partial))
      .slice(0, 8)
      .map((u) => ({ icon: 'user', label: u, apply: () => replaceToken(token, `by:${u}`) }));
  }
  return [];
}

function updateSuggestions() {
  const token = getCurrentToken(searchInputEl.value, searchInputEl.selectionStart);
  const items = suggestionItemsFor(token);
  const box = document.getElementById('search-suggest');
  if (items.length === 0) {
    hideSuggestions();
    return;
  }
  suggestIndex = -1;
  // The full key list (no ":" typed yet) gets a "Filters" header, same as
  // the rest of that menu — narrowing to one key's specific options (a
  // date, a device, a username) doesn't need it.
  const showHeader = !token.text.includes(':');
  box.innerHTML =
    (showHeader ? '<div class="search-suggest-header">Filters</div>' : '') +
    items
      .map(
        (item, i) => `
      <div class="search-suggest-item" data-idx="${i}">
        <i data-lucide="${item.icon}"></i>
        <div class="search-suggest-text">
          <span class="search-suggest-label">${escapeHtml(item.label)}</span>
          ${item.sub ? `<span class="search-suggest-sub">${escapeHtml(item.sub)}</span>` : ''}
        </div>
      </div>`,
      )
      .join('');
  box.style.display = 'block';
  if (window.lucide) window.lucide.createIcons();
  box.querySelectorAll('.search-suggest-item').forEach((el, i) => {
    el.addEventListener('mousedown', (e) => { e.preventDefault(); items[i].apply(); hideSuggestions(); });
    el.addEventListener('mouseenter', () => setActiveSuggestion(i));
  });
  box.dataset.itemCount = items.length;
  box._items = items;
}

function setActiveSuggestion(i) {
  suggestIndex = i;
  document.querySelectorAll('.search-suggest-item').forEach((el, idx) => el.classList.toggle('active', idx === i));
}

function hideSuggestions() {
  const box = document.getElementById('search-suggest');
  box.style.display = 'none';
  box.innerHTML = '';
  suggestIndex = -1;
}

function handleSuggestKeydown(e) {
  const box = document.getElementById('search-suggest');
  if (box.style.display === 'none') return false;
  const items = box._items || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSuggestion(Math.min(suggestIndex + 1, items.length - 1)); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion(Math.max(suggestIndex - 1, 0)); return true; }
  if (e.key === 'Enter' && suggestIndex >= 0) { e.preventDefault(); items[suggestIndex].apply(); hideSuggestions(); return true; }
  if (e.key === 'Escape') { hideSuggestions(); return true; }
  return false;
}

if (window.lucide) window.lucide.createIcons(); // static topbar icons present before load() runs

load();
