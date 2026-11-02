(() => {
  'use strict';
  // Navigation is never authorization. The destination performs its own LINE
  // verification and server-side merchant ownership / active-status checks.
  const validBusiness = value => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
  function sync(config) {
    const panel = document.getElementById('clientPageTitleShortcut');
    const link = document.getElementById('clientPageTitleSettingsLink');
    if (!panel || !link) return;
    const business = typeof config?.business === 'string' ? config.business : '';
    // Do not show a privileged settings shortcut in the unscoped/legacy area.
    const allowed = Boolean(config?.productizedAdmin) && validBusiness(business);
    if (!allowed) {
      link.removeAttribute('href');
      panel.hidden = true;
      return;
    }
    const target = new URL('/admin/workspace.html', window.location.origin);
    target.searchParams.set('business', business);
    link.setAttribute('href', target.pathname + target.search);
    panel.hidden = false;
  }
  function clear() { sync(null); }
  Object.defineProperty(window, 'ClientPageTitleShortcut', {
    value: Object.freeze({ sync, clear }), writable: false, configurable: false,
  });
})();
