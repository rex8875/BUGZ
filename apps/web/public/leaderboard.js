const serverId = window.location.pathname.split('/')[2];
document.getElementById('back-link').href = `/dashboard/${serverId}`;

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
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  try {
    const me = await api(`/api/servers/${serverId}/me`);
    const scores = await api(`/api/servers/${serverId}/leaderboard`);
    render(scores, me.permissions.canManageBugs);
  } catch (err) {
    showError(err.message);
  }
}

function render(scores, canAdjust) {
  const board = document.getElementById('board');
  if (scores.length === 0) {
    board.innerHTML = '<div class="hint">No points on the board yet.</div>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  board.innerHTML = scores
    .map(
      (s, i) => `
      <div class="member-row" data-discord-id="${s.user.discordId}">
        <div style="width:28px;">${medals[i] || i + 1}</div>
        <div style="flex:1;">${escapeHtml(s.user.discordUsername)}</div>
        <div><strong>${s.points}</strong> pt${s.points === 1 ? '' : 's'}</div>
        ${canAdjust ? '<button data-adjust="-1">-1</button><button data-adjust="1">+1</button>' : ''}
      </div>`,
    )
    .join('');

  board.querySelectorAll('[data-adjust]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const discordId = btn.closest('[data-discord-id]').dataset.discordId;
      try {
        await api(`/api/servers/${serverId}/leaderboard/${discordId}/adjust`, {
          method: 'POST',
          body: JSON.stringify({ delta: Number(btn.dataset.adjust) }),
        });
        await load();
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

load();
