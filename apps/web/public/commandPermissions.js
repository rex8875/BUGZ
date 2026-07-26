// Self-contained, like every other page script here (servers.js,
// board.js each define their own api()/escapeHtml() too rather than
// sharing across <script> tags) — loads on the same page as roles.js
// but has no dependency on it.
(function () {
  const serverId = window.location.pathname.split('/')[2];
  let cmdPermsData = null; // { roles, commands, overrides }
  let searchQuery = '';
  let expandedCommand = null;
  // Roles the person has checked/unchecked for the currently-expanded
  // command, before saving — kept separate from cmdPermsData.overrides
  // so "Save" vs "discard by collapsing" is a real, visible choice.
  let pendingSelection = null;

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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadCommandPermissions() {
    const host = document.getElementById('cmd-perms-list');
    host.innerHTML = '<span class="loading-pulse">Loading commands…</span>';
    try {
      cmdPermsData = await api(`/api/servers/${serverId}/command-permissions`);
      renderCommandPermissions();
    } catch (err) {
      host.innerHTML = `<div class="hint">Couldn't load command permissions: ${escapeHtml(err.message)}</div>`;
    }
  }

  function roleColorCss(color) {
    if (!color) return '#99a1b3'; // Discord's "no color" default reads as grey, not black
    return '#' + color.toString(16).padStart(6, '0');
  }

  function renderCommandPermissions() {
    if (!cmdPermsData) return;

    const overriddenCount = Object.keys(cmdPermsData.overrides).length;
    document.getElementById('cmd-perms-summary').textContent =
      overriddenCount === 0
        ? `All ${cmdPermsData.commands.length} commands are using default permissions.`
        : `${overriddenCount} of ${cmdPermsData.commands.length} command${cmdPermsData.commands.length === 1 ? '' : 's'} customized.`;

    const filtered = cmdPermsData.commands.filter(
      (c) => c.name.toLowerCase().includes(searchQuery) || c.description.toLowerCase().includes(searchQuery),
    );

    const list = document.getElementById('cmd-perms-list');
    if (filtered.length === 0) {
      list.innerHTML = '<div class="hint">No commands match your search.</div>';
      return;
    }

    list.innerHTML = filtered
      .map((cmd) => {
        const override = cmdPermsData.overrides[cmd.name] || [];
        const isExpanded = expandedCommand === cmd.name;
        const statusHtml =
          override.length > 0
            ? `<span class="cmd-row-status restricted">Restricted to ${override.length} role${override.length === 1 ? '' : 's'}</span>`
            : `<span class="cmd-row-status default">Default</span>`;

        return `
          <div class="cmd-row ${override.length > 0 ? 'has-override' : ''} ${isExpanded ? 'expanded' : ''}" data-cmd="${escapeHtml(cmd.name)}">
            <div class="cmd-row-header" data-toggle="${escapeHtml(cmd.name)}">
              <div>
                <div class="cmd-row-name">/${escapeHtml(cmd.name)}</div>
                <div class="cmd-row-desc">${escapeHtml(cmd.description)}</div>
              </div>
              ${statusHtml}
            </div>
            <div class="cmd-row-body">${isExpanded ? commandBodyHtml(cmd, override) : ''}</div>
          </div>`;
      })
      .join('');

    list.querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const cmdName = el.dataset.toggle;
        if (expandedCommand === cmdName) {
          expandedCommand = null;
          pendingSelection = null;
        } else {
          expandedCommand = cmdName;
          pendingSelection = new Set(cmdPermsData.overrides[cmdName] || []);
        }
        renderCommandPermissions();
      });
    });

    if (expandedCommand) wireExpandedCommandControls(expandedCommand);
  }

  function commandBodyHtml(cmd, currentOverride) {
    if (cmdPermsData.roles.length === 0) {
      return '<div class="cmd-no-roles-hint">This server has no custom Discord roles to choose from yet.</div>';
    }

    const rolesHtml = cmdPermsData.roles
      .map(
        (role) => `
        <label class="cmd-role-option">
          <input type="checkbox" data-role-checkbox="${escapeHtml(role.id)}" ${currentOverride.includes(role.id) ? 'checked' : ''} />
          <span class="cmd-role-dot" style="background:${roleColorCss(role.color)};"></span>
          ${escapeHtml(role.name)}
        </label>`,
      )
      .join('');

    return `
      <div class="cmd-role-grid">${rolesHtml}</div>
      <div class="cmd-row-actions">
        <button class="primary" data-save="${escapeHtml(cmd.name)}">Save</button>
        <button data-clear="${escapeHtml(cmd.name)}">Reset to default</button>
        <span class="hint" id="cmd-perms-error-${escapeHtml(cmd.name)}"></span>
      </div>`;
  }

  function wireExpandedCommandControls(cmdName) {
    document.querySelectorAll(`[data-role-checkbox]`).forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) pendingSelection.add(cb.dataset.roleCheckbox);
        else pendingSelection.delete(cb.dataset.roleCheckbox);
      });
    });

    const saveBtn = document.querySelector(`[data-save="${CSS.escape(cmdName)}"]`);
    if (saveBtn) {
      saveBtn.addEventListener('click', () => saveOverride(cmdName, [...pendingSelection]));
    }
    const clearBtn = document.querySelector(`[data-clear="${CSS.escape(cmdName)}"]`);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => saveOverride(cmdName, []));
    }
  }

  async function saveOverride(cmdName, discordRoleIds) {
    const saveBtn = document.querySelector(`[data-save="${CSS.escape(cmdName)}"]`);
    try {
      const result = await api(`/api/servers/${serverId}/command-permissions/${encodeURIComponent(cmdName)}`, {
        method: 'PATCH',
        body: JSON.stringify({ discordRoleIds }),
      });
      if (result.discordRoleIds.length > 0) cmdPermsData.overrides[cmdName] = result.discordRoleIds;
      else delete cmdPermsData.overrides[cmdName];

      if (saveBtn) {
        saveBtn.classList.add('save-success');
        saveBtn.textContent = 'Saved ✓';
      }
      setTimeout(() => {
        expandedCommand = null;
        pendingSelection = null;
        renderCommandPermissions();
      }, 420);
    } catch (err) {
      const errEl = document.getElementById(`cmd-perms-error-${cmdName}`);
      if (errEl) errEl.textContent = err.message;
    }
  }

  document.getElementById('cmd-perms-search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderCommandPermissions();
  });

  loadCommandPermissions();
})();
