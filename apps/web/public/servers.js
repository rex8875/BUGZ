let servers = [];
let openCustomizeId = null;

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

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

async function loadServers() {
  const res = await fetch('/api/servers');
  if (res.status === 401) return (window.location.href = '/auth/discord');
  servers = await res.json();
  renderGrid();
}

function renderGrid() {
  const list = document.getElementById('list');
  if (servers.length === 0) {
    list.innerHTML = '<div class="hint">You don\'t have access to any server\'s dashboard yet.</div>';
    return;
  }

  list.innerHTML = `<div class="servers-grid">${servers.map((s) => serverCardHtml(s)).join('')}</div>`;

  servers.forEach((s) => {
    if (s.permissions.canManageSettings) {
      const btn = document.getElementById(`customize-btn-${s.id}`);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCustomizeId = openCustomizeId === s.id ? null : s.id;
          renderGrid();
          if (openCustomizeId === s.id) renderCustomizePanel(s);
        });
      }
    }
  });
}

function serverCardHtml(s) {
  let bg = '';
  if (s.backgroundStyle) {
    if (s.backgroundStyle.startsWith('linear-gradient')) {
      bg = `style="background-image:${s.backgroundStyle};"`;
    } else {
      bg = `style="background-color:${s.backgroundStyle};"`;
    }
  }
  const avatar = s.iconUrl
    ? `<img class="server-avatar" src="${escapeHtml(s.iconUrl)}" alt="" />`
    : `<div class="server-avatar">${escapeHtml(initials(s.name))}</div>`;

  return `
    <div class="server-card-outer">
      <a class="server-card" href="/dashboard/${s.id}" ${bg}>
        ${s.permissions.canManageSettings ? `<button class="server-customize-btn" id="customize-btn-${s.id}">Customize</button>` : ''}
        <div class="server-card-body">
          ${avatar}
          <div class="server-card-name">${escapeHtml(s.name)}</div>
        </div>
        <div class="server-card-sub">${s.permissions.canManageBugs ? 'DEV ACCESS' : 'VIEW ACCESS'}</div>
      </a>
      <div id="appearance-panel-${s.id}"></div>
    </div>`;
}

function renderCustomizePanel(s) {
  const host = document.getElementById(`appearance-panel-${s.id}`);
  if (!host) return;
  host.innerHTML = `
    <div class="appearance-panel">
      <h3>Background — ${escapeHtml(s.name)}</h3>
      <div id="picker-mount-${s.id}"></div>
      <div class="quick-actions" style="border:none;margin-top:14px;padding-top:0;">
        <button class="primary" id="save-appearance-${s.id}">Save background</button>
        <button id="clear-appearance-${s.id}">Reset to default</button>
        <span class="hint" id="appearance-error-${s.id}"></span>
      </div>
    </div>`;

  const picker = window.FieldLogColorPicker.createAppearancePicker({
    container: document.getElementById(`picker-mount-${s.id}`),
    initialValue: s.backgroundStyle,
  });

  document.getElementById(`save-appearance-${s.id}`).addEventListener('click', async () => {
    try {
      const updated = await api(`/api/servers/${s.id}/appearance`, {
        method: 'PATCH',
        body: JSON.stringify({ backgroundStyle: picker.getValue() }),
      });
      s.backgroundStyle = updated.backgroundStyle;
      openCustomizeId = null;
      renderGrid();
    } catch (err) {
      document.getElementById(`appearance-error-${s.id}`).textContent = err.message;
    }
  });

  document.getElementById(`clear-appearance-${s.id}`).addEventListener('click', async () => {
    try {
      const updated = await api(`/api/servers/${s.id}/appearance`, {
        method: 'PATCH',
        body: JSON.stringify({ backgroundStyle: null }),
      });
      s.backgroundStyle = updated.backgroundStyle;
      openCustomizeId = null;
      renderGrid();
    } catch (err) {
      document.getElementById(`appearance-error-${s.id}`).textContent = err.message;
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadServers();
