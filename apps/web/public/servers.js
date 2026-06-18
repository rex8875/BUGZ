async function loadServers() {
  const res = await fetch('/api/servers');
  if (res.status === 401) return (window.location.href = '/auth/discord');
  const servers = await res.json();

  const list = document.getElementById('list');
  if (servers.length === 0) {
    list.textContent = "You don't have access to any server's dashboard yet.";
    return;
  }

  list.innerHTML = servers
    .map(
      (s) => `
      <a class="server-card" href="/dashboard/${s.id}">
        <strong>${escapeHtml(s.name)}</strong>
        <div class="hint">${s.permissions.canManageBugs ? 'Dev access' : 'View access'}</div>
      </a>`,
    )
    .join('');
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadServers();
