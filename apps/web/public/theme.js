// Dashboard-wide background theme — a personal preference (not tied to
// any one server) that stays consistent across the server list and
// every per-server page, and follows your Discord identity across
// devices/browsers. Separate from a server's own custom
// background/gradient, which a server owner sets for that server
// specifically (see colorPicker.js) and which still layers on top of
// whichever theme is active, only on that server's own board page.
//
// Saved server-side (tied to your account) so it transfers between
// devices, with localStorage as an instant local cache — applied
// immediately on load with no network wait, then reconciled with the
// server in the background in case it was changed elsewhere. The
// actual theme definitions (body.theme-*) live in style.css.
(function () {
  const THEMES = [
    { id: 'ink', label: 'Ink' },
    { id: 'aurora', label: 'Aurora' },
    { id: 'mesh', label: 'Mesh' },
    { id: 'cyber', label: 'Cyber' },
    { id: 'duotone', label: 'Duotone' },
    { id: 'glass', label: 'Glass' },
  ];
  const STORAGE_KEY = 'fieldlog-theme';
  let popoverEls = null; // set once the picker UI exists, so a server reconciliation can update it if it already opened

  function readLocal() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return THEMES.some((t) => t.id === saved) ? saved : 'ink';
    } catch {
      return 'ink';
    }
  }

  function writeLocal(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // private browsing / storage disabled — theme still applies for
      // this page view via the class below, it just won't be cached
    }
  }

  function applyTheme(id) {
    for (const t of THEMES) document.body.classList.remove(`theme-${t.id}`);
    if (id !== 'ink') document.body.classList.add(`theme-${id}`);
    if (popoverEls) {
      popoverEls.forEach((el) => el.classList.toggle('active', el.dataset.theme === id));
    }
  }

  // Sets the theme everywhere: applied to this page immediately, cached
  // locally, and saved to the account in the background so it's there
  // next time on any device. The background save is best-effort — if it
  // fails (offline, session hiccup), the choice still applies for this
  // page view, it just may not have transferred.
  function setTheme(id, { skipSave = false } = {}) {
    writeLocal(id);
    applyTheme(id);
    if (skipSave || typeof fetch !== 'function') return;
    fetch('/api/me/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: id }),
    }).catch(() => {
      // offline or not signed in on this request for some reason — the
      // local choice above still stands for this page view
    });
  }

  // Applied immediately from the local cache (this script loads first,
  // before the rest of the page body) rather than waiting on a network
  // round trip, so the page doesn't visibly flash the default theme.
  applyTheme(readLocal());

  // Reconcile with the account in the background — picks up a theme
  // set on another device/browser since this one last saved a value.
  if (typeof fetch === 'function') {
    fetch('/api/me/theme')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.theme && data.theme !== readLocal()) {
          writeLocal(data.theme);
          applyTheme(data.theme);
        }
      })
      .catch(() => {
        // not signed in, offline, etc — the local cache (or default)
        // already applied above stands as-is
      });
  }

  function buildPicker() {
    const btn = document.createElement('button');
    btn.className = 'theme-picker-btn';
    btn.type = 'button';
    btn.title = 'Dashboard background';
    btn.setAttribute('aria-label', 'Choose dashboard background');
    btn.innerHTML = '<i data-lucide="palette"></i>';

    const popover = document.createElement('div');
    popover.className = 'theme-picker-popover';
    popover.innerHTML = `
      <div class="theme-picker-title">Background</div>
      <div class="theme-swatch-grid">
        ${THEMES.map(
          (t) => `
          <div>
            <div class="theme-swatch theme-swatch-${t.id} ${readLocal() === t.id ? 'active' : ''}" data-theme="${t.id}" title="${t.label}"></div>
            <div class="theme-swatch-label">${t.label}</div>
          </div>`,
        ).join('')}
      </div>`;
    document.body.appendChild(popover);
    popoverEls = [...popover.querySelectorAll('.theme-swatch')];

    function positionPopover() {
      const r = btn.getBoundingClientRect();
      const top = Math.min(r.top, window.innerHeight - popover.offsetHeight - 12);
      popover.style.left = `${Math.round(r.right + 10)}px`;
      popover.style.top = `${Math.round(Math.max(top, 12))}px`;
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !popover.classList.contains('open');
      popover.classList.remove('open');
      if (opening) {
        positionPopover();
        popover.classList.add('open');
      }
    });
    document.addEventListener('click', (e) => {
      if (popover.classList.contains('open') && !popover.contains(e.target) && e.target !== btn) {
        popover.classList.remove('open');
      }
    });
    popover.addEventListener('click', (e) => {
      const swatch = e.target.closest('[data-theme]');
      if (!swatch) return;
      setTheme(swatch.dataset.theme);
    });

    return btn;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const rail = document.getElementById('server-rail');
    const btn = buildPicker();
    if (rail) {
      btn.style.marginTop = 'auto';
      rail.appendChild(btn);
    } else {
      btn.style.position = 'fixed';
      btn.style.top = '16px';
      btn.style.right = '16px';
      btn.style.zIndex = '40';
      document.body.appendChild(btn);
    }
    if (window.lucide) window.lucide.createIcons();
  });
})();
