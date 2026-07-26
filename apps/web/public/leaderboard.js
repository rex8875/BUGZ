const serverId = window.location.pathname.split('/')[2];
document.getElementById('back-link').href = `/dashboard/${serverId}`;

let canAdjust = false;
let tab = 'all-time';
let weekStart = null; // null = current week, server resolves it

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

document.querySelectorAll('#lb-tabs [data-tab]').forEach((el) => {
  el.addEventListener('click', () => {
    tab = el.dataset.tab;
    weekStart = null;
    document.querySelectorAll('#lb-tabs [data-tab]').forEach((t) => t.classList.toggle('active', t === el));
    document.getElementById('week-nav').style.display = tab === 'weekly' ? 'block' : 'none';
    load();
  });
});

document.getElementById('prev-week').addEventListener('click', () => {
  const d = weekStart ? new Date(weekStart) : new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  weekStart = d.toISOString();
  load();
});

document.getElementById('next-week').addEventListener('click', () => {
  const d = weekStart ? new Date(weekStart) : new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  weekStart = d.toISOString();
  load();
});

async function load() {
  try {
    const me = await api(`/api/servers/${serverId}/me`);
    canAdjust = me.permissions.canManageBugs;

    if (tab === 'all-time') {
      const scores = await api(`/api/servers/${serverId}/leaderboard`);
      render(scores);
    } else {
      const params = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : '';
      const result = await api(`/api/servers/${serverId}/leaderboard/weekly${params}`);
      const label = new Date(result.weekStart);
      document.getElementById('week-label').textContent = `Week of ${label.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
      render(result.scores);
    }
  } catch (err) {
    showError(err.message);
  }
}

function render(scores) {
  const board = document.getElementById('board');
  if (scores.length === 0) {
    board.innerHTML = '<div class="hint">No points here yet.</div>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  board.innerHTML = scores
    .map((s, i) => {
      const entranceClass = i < 3 ? 'animate__bounceIn' : 'animate__fadeInUp animate__faster';
      const delay = i < 3 ? i * 120 : Math.min(i, 15) * 30 + 100;
      return `
      <div class="member-row animate__animated ${entranceClass}" data-discord-id="${s.user.discordId}" style="animation-delay:${delay}ms">
        <div style="width:28px;">${medals[i] || i + 1}</div>
        <div style="flex:1;">${escapeHtml(s.user.discordUsername)}</div>
        <div><strong>${s.points}</strong> pt${s.points === 1 ? '' : 's'}</div>
        ${tab === 'all-time' && canAdjust ? '<button data-adjust="-1">-1</button><button data-adjust="1">+1</button>' : ''}
      </div>`;
    })
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
