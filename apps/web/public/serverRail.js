// Discord's own left-edge server rail, reproduced here so switching
// servers doesn't require going back to the "All servers" grid first.
// Self-contained and duplicated per the rest of this codebase's own
// convention (see board.js/roles.js/servers.js each defining their own
// small helpers rather than sharing a module system) — loaded as its
// own <script> tag on every "inside a server" page plus the picker
// itself, exactly like Discord always shows this rail regardless of
// which space you're in.

(function () {
  function currentServerIdFromPath() {
    const match = window.location.pathname.match(/^\/dashboard\/([^/]+)/);
    return match ? match[1] : null;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function iconHtml(server) {
    if (server.iconUrl) {
      return `<img src="${escapeHtml(server.iconUrl)}" alt="" />`;
    }
    return `<span class="rail-initials">${escapeHtml(initials(server.name))}</span>`;
  }

  async function renderServerRail() {
    const mount = document.getElementById('server-rail');
    if (!mount) return;

    let servers = [];
    try {
      const res = await fetch('/api/servers');
      if (!res.ok) return; // fail silently — the rail is a convenience, not core navigation, and every page already has "All servers"/"Back to dashboard" links that work regardless
      servers = await res.json();
    } catch {
      return;
    }

    const activeId = currentServerIdFromPath();

    mount.innerHTML = `
      <a href="/dashboard" class="rail-icon rail-home ${activeId ? '' : 'rail-active'}" title="All servers">
        <i data-lucide="layout-grid"></i>
      </a>
      <div class="rail-divider"></div>
      <div class="rail-servers">
        ${servers
          .map(
            (s) => `
          <a href="/dashboard/${s.id}" class="rail-icon ${s.id === activeId ? 'rail-active' : ''}" title="${escapeHtml(s.name)}">
            ${iconHtml(s)}
          </a>`,
          )
          .join('')}
      </div>`;

    if (window.lucide) window.lucide.createIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderServerRail);
  } else {
    renderServerRail();
  }
})();
