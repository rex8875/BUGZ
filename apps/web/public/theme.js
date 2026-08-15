// Dashboard-wide background theme — a personal preference (not tied to
// any one server) that stays consistent across the server list and
// every per-server page. Separate from a server's own custom
// background/gradient, which a server owner sets for that server
// specifically (see colorPicker.js) and which still layers on top of
// whichever theme is active, only on that server's own board page.
//
// Stored client-side (localStorage) since this is purely cosmetic and
// personal — no need for a backend field or an API round-trip just to
// remember which background someone likes. The actual theme
// definitions (body.theme-*) live in style.css.
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

  function getTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return THEMES.some((t) => t.id === saved) ? saved : 'ink';
    } catch {
      return 'ink';
    }
  }

  function applyTheme(id) {
    for (const t of THEMES) document.body.classList.remove(`theme-${t.id}`);
    if (id !== 'ink') document.body.classList.add(`theme-${id}`);
  }

  function setTheme(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // private browsing / storage disabled — theme still applies for
      // this page view, it just won't be remembered next time
    }
    applyTheme(id);
  }

  // Applied immediately (this script is loaded first, before the rest
  // of the page body) rather than waiting for DOMContentLoaded, so the
  // page doesn't visibly flash the default theme first.
  applyTheme(getTheme());

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
            <div class="theme-swatch theme-swatch-${t.id} ${getTheme() === t.id ? 'active' : ''}" data-theme="${t.id}" title="${t.label}"></div>
            <div class="theme-swatch-label">${t.label}</div>
          </div>`,
        ).join('')}
      </div>`;
    document.body.appendChild(popover);

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
      popover.querySelectorAll('.theme-swatch').forEach((el) => el.classList.toggle('active', el.dataset.theme === swatch.dataset.theme));
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
