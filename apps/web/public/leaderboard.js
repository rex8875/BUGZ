const serverId = window.location.pathname.split('/')[2];
document.getElementById('back-link').href = `/dashboard/${serverId}`;

let canAdjust = false;
let myDiscordId = null;
let tab = 'all-time';
let weekStart = null; // null = current week, server resolves it
let hasCelebrated = false; // only fire confetti once per page load, not on every refresh

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
    myDiscordId = me.discordId;

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

function adjustButtonsHtml(discordId) {
  if (tab !== 'all-time' || !canAdjust) return '';
  return `
    <div class="lb-adjust">
      <button data-adjust="-1" title="Remove a point"><i data-lucide="minus"></i></button>
      <button data-adjust="1" title="Add a point"><i data-lucide="plus"></i></button>
    </div>`;
}

function podiumCardHtml(s, rank, maxPoints) {
  const icon = rank === 1 ? 'trophy' : 'medal';
  const barPct = maxPoints > 0 ? Math.max(6, Math.round((s.points / maxPoints) * 100)) : 0;
  const isMe = s.user.discordId === myDiscordId;
  return `
    <div class="lb-podium-card rank-${rank} animate__animated animate__bounceIn" data-discord-id="${s.user.discordId}" style="animation-delay:${(3 - rank) * 130}ms">
      <div class="lb-podium-icon"><i data-lucide="${icon}"></i></div>
      <div class="lb-podium-rank">#${rank}</div>
      <div class="lb-podium-name">${escapeHtml(s.user.discordUsername)} ${isMe ? '<span class="lb-you">YOU</span>' : ''}</div>
      <div class="lb-podium-points">${s.points}<span>pt${s.points === 1 ? '' : 's'}</span></div>
      <div class="lb-bar-track"><div class="lb-bar-fill" style="width:${barPct}%"></div></div>
      ${adjustButtonsHtml(s.user.discordId)}
    </div>`;
}

function listRowHtml(s, rank, maxPoints) {
  const barPct = maxPoints > 0 ? Math.max(4, Math.round((s.points / maxPoints) * 100)) : 0;
  const isMe = s.user.discordId === myDiscordId;
  return `
    <div class="lb-row animate__animated animate__fadeInUp animate__faster ${isMe ? 'lb-row-me' : ''}" data-discord-id="${s.user.discordId}" style="animation-delay:${Math.min(rank, 18) * 25}ms">
      <div class="lb-rank-badge">${rank}</div>
      <div class="lb-row-main">
        <div class="lb-row-name">${escapeHtml(s.user.discordUsername)} ${isMe ? '<span class="lb-you">YOU</span>' : ''}</div>
        <div class="lb-bar-track lb-bar-track-sm"><div class="lb-bar-fill" style="width:${barPct}%"></div></div>
      </div>
      <div class="lb-row-points">${s.points} <span>pt${s.points === 1 ? '' : 's'}</span></div>
      ${adjustButtonsHtml(s.user.discordId)}
    </div>`;
}

function render(scores) {
  const board = document.getElementById('board');
  if (scores.length === 0) {
    board.innerHTML = '<div class="hint lb-empty"><i data-lucide="inbox"></i> No points here yet.</div>';
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  const maxPoints = scores[0].points;
  const top3 = scores.slice(0, 3);
  const rest = scores.slice(3);

  const podiumOrder = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3; // 2nd, 1st, 3rd visual order
  const podiumHtml = top3.length
    ? `<div class="lb-podium">${podiumOrder.map((s) => podiumCardHtml(s, scores.indexOf(s) + 1, maxPoints)).join('')}</div>`
    : '';

  const listHtml = rest.length
    ? `<div class="lb-list">${rest.map((s, i) => listRowHtml(s, i + 4, maxPoints)).join('')}</div>`
    : '';

  board.innerHTML = podiumHtml + listHtml;
  if (window.lucide) window.lucide.createIcons();

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

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!hasCelebrated && !reducedMotion && tab === 'all-time' && top3.length && typeof window.confetti === 'function') {
    hasCelebrated = true;
    window.confetti({
      particleCount: 90,
      spread: 70,
      origin: { y: 0.35 },
      colors: ['#f5a623', '#ffd166', '#ffffff'], // on-brand amber palette, not the library's default rainbow
      disableForReducedMotion: true,
    });
  }
}

load();
