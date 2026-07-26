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
  ['canKickMembers', 'Kick members'],
  ['canBanMembers', 'Ban members'],
  ['canManageRoles', 'Manage roles'],
  ['canManageSettings', 'Manage settings'],
];

let roles = [];

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

function permGridHtml(prefix, current = {}) {
  return PERMISSION_FIELDS.map(
    ([key, label]) =>
      `<label><input type="checkbox" data-perm="${key}" id="${prefix}-${key}" ${current[key] ? 'checked' : ''}/> ${label}</label>`,
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
    document.getElementById('new-role-perms').innerHTML = permGridHtml('new');

    roles = await api(`/api/servers/${serverId}/roles`);
    renderRoles();
    document.getElementById('new-member-role').innerHTML = roles
      .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
      .join('');

    const members = await api(`/api/servers/${serverId}/members`);
    renderMembers(members);

    const banned = await api(`/api/servers/${serverId}/banned`);
    renderBanned(banned);

    const audit = await api(`/api/servers/${serverId}/audit-log`);
    renderAuditLog(audit);
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById('add-member-btn').addEventListener('click', async () => {
  const discordId = document.getElementById('new-member-id').value.trim();
  const roleId = document.getElementById('new-member-role').value;
  if (!discordId) return showError('Enter a Discord ID.');

  try {
    await api(`/api/servers/${serverId}/members/${discordId}/roles/${roleId}/grant`, { method: 'POST' });
    document.getElementById('new-member-id').value = '';
    await load();
  } catch (err) {
    showError(err.message);
  }
});

function renderRoles() {
  document.getElementById('role-list').innerHTML = roles
    .map(
      (role) => `
      <div class="role-card" data-role-id="${role.id}">
        <div class="role-card-header">
          <strong>${escapeHtml(role.name)}</strong>
          <label class="hint" style="display:flex; align-items:center; gap:4px;">rank <input type="number" data-rank-input value="${role.rank}" style="width:60px;" /></label>
        </div>
        <div class="perm-grid">${permGridHtml(`role-${role.id}`, role)}</div>
        <div style="margin-top:10px; display:flex; gap:8px;">
          <button data-save-role="${role.id}">Save</button>
          <button data-delete-role="${role.id}">Delete</button>
        </div>
      </div>`,
    )
    .join('');

  document.querySelectorAll('[data-save-role]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('[data-role-id]');
      const perms = readPermGrid(card);
      const rank = parseInt(card.querySelector('[data-rank-input]').value, 10);
      if (!Number.isNaN(rank)) perms.rank = rank;
      try {
        await api(`/api/servers/${serverId}/roles/${btn.dataset.saveRole}`, { method: 'PATCH', body: JSON.stringify(perms) });
        await load();
      } catch (err) {
        showError(err.message);
      }
    });
  });

  document.querySelectorAll('[data-delete-role]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this role? Members holding it must be reassigned first.')) return;
      try {
        await api(`/api/servers/${serverId}/roles/${btn.dataset.deleteRole}`, { method: 'DELETE' });
        await load();
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

document.getElementById('create-role-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-role-name').value.trim();
  const rank = parseInt(document.getElementById('new-role-rank').value, 10);
  const perms = readPermGrid(document.getElementById('new-role-perms'));

  if (!name || Number.isNaN(rank)) return showError('Role needs a name and a numeric rank.');

  try {
    await api(`/api/servers/${serverId}/roles`, { method: 'POST', body: JSON.stringify({ name, rank, ...perms }) });
    document.getElementById('new-role-name').value = '';
    document.getElementById('new-role-rank').value = '';
    await load();
  } catch (err) {
    showError(err.message);
  }
});

// Each member shows a checkbox per server role — checked if they hold it.
// Toggling grants or revokes that ONE role immediately, leaving every
// other role they hold untouched, matching real Discord role behavior.
function renderMembers(members) {
  document.getElementById('member-list').innerHTML = members
    .map((m) => {
      const heldRoleIds = new Set(m.roles.map((mr) => mr.roleId));
      const roleChips = roles
        .map(
          (r) => `
          <label style="display:inline-flex; align-items:center; gap:3px; font-size:12px; margin-right:8px;">
            <input type="checkbox" data-role-toggle="${r.id}" ${heldRoleIds.has(r.id) ? 'checked' : ''} /> ${escapeHtml(r.name)}
          </label>`,
        )
        .join('');

      return `
      <div class="member-row" data-discord-id="${m.user.discordId}" style="flex-wrap:wrap;">
        <div style="flex:1; min-width:140px;">${escapeHtml(m.user.discordUsername)}</div>
        <div style="flex-basis:100%; margin:4px 0;">${roleChips}</div>
        <button data-kick>Kick</button>
        <button data-ban>Ban</button>
      </div>`;
    })
    .join('');

  document.querySelectorAll('[data-role-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const discordId = checkbox.closest('[data-discord-id]').dataset.discordId;
      const roleId = checkbox.dataset.roleToggle;
      const action = checkbox.checked ? 'grant' : 'revoke';
      try {
        await api(`/api/servers/${serverId}/members/${discordId}/roles/${roleId}/${action}`, { method: 'POST' });
        await load();
      } catch (err) {
        checkbox.checked = !checkbox.checked; // revert the visual toggle since the change didn't actually apply
        showError(err.message);
      }
    });
  });

  document.querySelectorAll('[data-kick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const discordId = btn.closest('[data-discord-id]').dataset.discordId;
      if (!confirm('Kick this member? They can be re-added later.')) return;
      try {
        await api(`/api/servers/${serverId}/members/${discordId}/kick`, { method: 'POST' });
        await load();
      } catch (err) {
        showError(err.message);
      }
    });
  });

  document.querySelectorAll('[data-ban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const discordId = btn.closest('[data-discord-id]').dataset.discordId;
      const reason = prompt('Reason for ban (optional)') || undefined;
      try {
        await api(`/api/servers/${serverId}/members/${discordId}/ban`, { method: 'POST', body: JSON.stringify({ reason }) });
        await load();
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

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
