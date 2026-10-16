(() => {
  'use strict';

  const STORAGE_KEY = 'lumen-color-theme-v1';
  const DARK = 'dark';
  const LIGHT = 'light';
  const root = document.documentElement;
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  let toggleButton = null;
  let currentTheme = '';

  function isTheme(value) {
    return value === LIGHT || value === DARK;
  }

  function readStoredTheme() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return isTheme(value) ? value : '';
    } catch {
      return '';
    }
  }

  function preferredTheme() {
    return readStoredTheme() || (media?.matches ? DARK : LIGHT);
  }

  function syncThemeMeta(theme) {
    if (!themeMeta) return;
    const next = theme === DARK ? '#101512' : '#f9fbf9';
    if (themeMeta.content !== next) themeMeta.content = next;
  }

  function syncToggle(theme) {
    const button = toggleButton || document.getElementById('themeToggleButton');
    if (!button) return;
    toggleButton = button;

    const isDark = theme === DARK;
    const pressed = String(isDark);
    const label = isDark ? '切換為亮色調' : '切換為暗色調';
    const text = isDark ? '☀ 亮色' : '☾ 暗色';

    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.title !== label) button.title = label;
    if (button.textContent !== text) button.textContent = text;
  }

  function persistTheme(theme) {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== theme) {
        window.localStorage.setItem(STORAGE_KEY, theme);
      }
    } catch {}
  }

  function applyTheme(theme, options = {}) {
    const next = isTheme(theme) ? theme : preferredTheme();
    const changed = currentTheme !== next || root.dataset.theme !== next;

    if (changed) {
      root.dataset.theme = next;
      currentTheme = next;
      syncThemeMeta(next);
      syncToggle(next);

      if (options.emit !== false) {
        window.dispatchEvent(new CustomEvent('lumen:themechange', { detail: { theme: next } }));
      }
    } else {
      syncToggle(next);
    }

    if (options.persist === true) persistTheme(next);
    return next;
  }

  function createToggle() {
    if (toggleButton?.isConnected) return toggleButton;

    const existing = document.getElementById('themeToggleButton');
    if (existing) {
      toggleButton = existing;
      syncToggle(currentTheme || preferredTheme());
      return existing;
    }

    const host = document.querySelector('.account-menu');
    if (!host) return null;

    const button = document.createElement('button');
    button.id = 'themeToggleButton';
    button.type = 'button';
    button.className = 'theme-toggle-button';
    button.dataset.uiThemeControl = 'true';

    const logout = host.querySelector('#logoutButton');
    if (logout) host.insertBefore(button, logout);
    else host.appendChild(button);

    toggleButton = button;
    syncToggle(currentTheme || preferredTheme());

    button.addEventListener('click', () => {
      const next = currentTheme === DARK ? LIGHT : DARK;
      applyTheme(next, { persist: true });
    });

    return button;
  }

  applyTheme(preferredTheme(), { emit: false });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createToggle, { once: true });
  } else {
    createToggle();
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = isTheme(event.newValue)
      ? event.newValue
      : (media?.matches ? DARK : LIGHT);
    applyTheme(next, { emit: false });
  });

  media?.addEventListener?.('change', (event) => {
    if (readStoredTheme()) return;
    applyTheme(event.matches ? DARK : LIGHT);
  });

  window.LumenTheme = Object.freeze({
    get: () => currentTheme || preferredTheme(),
    set: (theme) => applyTheme(theme, { persist: true }),
    reset: () => {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
      return applyTheme(media?.matches ? DARK : LIGHT);
    }
  });
})();
