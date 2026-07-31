const serverId = window.location.pathname.split('/')[2];
document.getElementById('back-link').href = `/dashboard/${serverId}`;

const PERMISSION_FIELDS = [
  ['canSubmitBugs', 'Submit bugs'],
  ['canViewDashboard', 'View dashboard'],
  ['canManageBugs', 'Manage bugs (status/priority)'],
  ['canPingTesters', 'Ping testers / retest'],
  ['canArchive', 'Archive'],
  ['canEditReports', 'Edit report content'],
  ['canDeleteReports', 'Delete reports'],
  ['canShareDashboard', 'Share dashboard'],
  ['canBanMembers', 'Ban members'],
  ['canManageRoles', 'Manage roles'],
  ['canManageSettings', 'Manage settings'],
];

let discordRoles = [];
let configuredByRoleId = {}; // discordRoleId -> RolePermission row
let roleSearchQuery = '';
let expandedRoleId = null;

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
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
    void el.offsetWidth;
    el.classList.add('animate__animated', 'animate__headShake');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function roleColorCss(color) {
  if (!color) return '#99a1b3';
  return '#' + color.toString(16).padStart(6, '0');
}

function permGridHtml(prefix, current = {}) {
  return PERMISSION_FIELDS.map(
    ([key, label]) =>
      `<label class="cmd-role-option"><input type="checkbox" data-perm="${key}" id="${prefix}-${key}" ${current[key] ? 'checked' : ''}/> ${label}</label>`,
  ).join('');
}

function readPermGrid(container) {
  const perms = {};
  container.querySelectorAll('[data-perm]').forEach((cb) => {
    perms[cb.dataset.perm] = cb.checked;
  });
  return perms;
}

async function load() {
  try {
    const rolePermsData = await api(`/api/servers/${serverId}/role-permissions`);
    discordRoles = rolePermsData.roles;
    configuredByRoleId = {};
    for (const row of rolePermsData.configured) configuredByRoleId[row.discordRoleId] = row;
    renderRoleList();

    const banned = await api(`/api/servers/${serverId}/banned`);
    renderBanned(banned);

    const audit = await api(`/api/servers/${serverId}/audit-log`);
    renderAuditLog(audit);
  } catch (err) {
    showError(err.message);
  }
}

function renderRoleList() {
  const configuredCount = Object.keys(configuredByRoleId).length;
  document.getElementById('role-perms-summary').textContent =
    configuredCount === 0
      ? `None of your ${discordRoles.length} Discord roles have bot permissions configured yet.`
      : `${configuredCount} of ${discordRoles.length} Discord role${discordRoles.length === 1 ? '' : 's'} configured.`;

  const filtered = discordRoles.filter((r) => r.name.toLowerCase().includes(roleSearchQuery));
  const list = document.getElementById('role-list');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="hint">No roles match your search.</div>';
    return;
  }

  list.innerHTML = filtered
    .map((role) => {
      const configured = configuredByRoleId[role.id];
      const enabledCount = configured ? PERMISSION_FIELDS.filter(([key]) => configured[key]).length : 0;
      const isExpanded = expandedRoleId === role.id;
      const statusHtml =
        enabledCount > 0
          ? `<span class="cmd-row-status restricted">${enabledCount} permission${enabledCount === 1 ? '' : 's'} enabled</span>`
          : `<span class="cmd-row-status default">No bot access</span>`;

      return `
        <div class="cmd-row animate__animated animate__fadeIn animate__faster ${enabledCount > 0 ? 'has-override' : ''} ${isExpanded ? 'expanded' : ''}" data-role-id="${role.id}">
          <div class="cmd-row-header" data-toggle-role="${role.id}">
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="cmd-role-dot" style="background:${roleColorCss(role.color)};"></span>
              <div class="cmd-row-name">${escapeHtml(role.name)}</div>
            </div>
            ${statusHtml}
          </div>
          <div class="cmd-row-body">${isExpanded ? roleBodyHtml(role, configured || {}) : ''}</div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-toggle-role]').forEach((el) => {
    el.addEventListener('click', () => {
      expandedRoleId = expandedRoleId === el.dataset.toggleRole ? null : el.dataset.toggleRole;
      renderRoleList();
    });
  });

  if (expandedRoleId) wireExpandedRoleControls(expandedRoleId);
}

function roleBodyHtml(role, current) {
  return `
    <div class="perm-grid">${permGridHtml(`role-${role.id}`, current)}</div>
    <div class="cmd-row-actions">
      <button class="primary" data-save-role="${role.id}">Save</button>
      <button data-clear-role="${role.id}">Reset to default (no access)</button>
      <span class="hint" id="role-perms-error-${role.id}"></span>
    </div>`;
}

function wireExpandedRoleControls(roleId) {
  const saveBtn = document.querySelector(`[data-save-role="${CSS.escape(roleId)}"]`);
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const card = document.querySelector(`[data-role-id="${CSS.escape(roleId)}"]`);
      const perms = readPermGrid(card);
      try {
        const updated = await api(`/api/servers/${serverId}/role-permissions/${roleId}`, { method: 'PATCH', body: JSON.stringify(perms) });
        configuredByRoleId[roleId] = updated;
        saveBtn.classList.add('save-success');
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => {
          expandedRoleId = null;
          renderRoleList();
        }, 420);
      } catch (err) {
        document.getElementById(`role-perms-error-${roleId}`).textContent = err.message;
      }
    });
  }

  const clearBtn = document.querySelector(`[data-clear-role="${CSS.escape(roleId)}"]`);
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${serverId}/role-permissions/${roleId}`, { method: 'DELETE' });
        delete configuredByRoleId[roleId];
        expandedRoleId = null;
        renderRoleList();
      } catch (err) {
        document.getElementById(`role-perms-error-${roleId}`).textContent = err.message;
      }
    });
  }
}

document.getElementById('role-search').addEventListener('input', (e) => {
  roleSearchQuery = e.target.value.trim().toLowerCase();
  renderRoleList();
});

document.getElementById('ban-member-btn').addEventListener('click', async () => {
  const discordId = document.getElementById('ban-member-id').value.trim();
  const reason = document.getElementById('ban-member-reason').value.trim() || undefined;
  if (!discordId) return showError('Enter a Discord ID.');

  try {
    await api(`/api/servers/${serverId}/members/${discordId}/ban`, { method: 'POST', body: JSON.stringify({ reason }) });
    document.getElementById('ban-member-id').value = '';
    document.getElementById('ban-member-reason').value = '';
    await load();
  } catch (err) {
    showError(err.message);
  }
});

function renderBanned(banned) {
  const list = document.getElementById('banned-list');
  if (banned.length === 0) {
    list.innerHTML = '<div class="hint">No one is banned.</div>';
    return;
  }

  list.innerHTML = banned
    .map(
      (b) => `
      <div class="banned-row" data-discord-id="${b.discordId}">
        <div style="flex:1;">${escapeHtml(b.discordId)} ${b.reason ? `— ${escapeHtml(b.reason)}` : ''}</div>
        <div class="hint">${new Date(b.bannedAt).toLocaleDateString()}</div>
        <button data-unban>Unban</button>
      </div>`,
    )
    .join('');

  list.querySelectorAll('[data-unban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const discordId = btn.closest('[data-discord-id]').dataset.discordId;
      try {
        await api(`/api/servers/${serverId}/members/${discordId}/unban`, { method: 'POST' });
        await load();
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

function renderAuditLog(entries) {
  const list = document.getElementById('audit-list');
  if (entries.length === 0) {
    list.innerHTML = '<div class="hint">No actions logged yet.</div>';
    return;
  }

  list.innerHTML = entries
    .map((e) => {
      let details = '';
      try {
        details = e.details ? ` — ${JSON.stringify(JSON.parse(e.details))}` : '';
      } catch {
        details = '';
      }
      return `
        <div class="audit-row">
          <div style="flex:1;">${escapeHtml(e.actorDiscordId)} — ${escapeHtml(e.action)}${escapeHtml(details)}</div>
          <div class="hint">${new Date(e.createdAt).toLocaleString()}</div>
        </div>`;
    })
    .join('');
}

load();
