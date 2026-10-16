(() => {
  'use strict';
  const source = document.currentScript;
  const version = source?.getAttribute('data-site-version') || '';
  if (!/^v\d{6}\.\d{6}-[a-z0-9]{6}$/.test(version)) return;

  const render = () => {
    if (!document.body || document.getElementById('site-build-version')) return;
    const badge = document.createElement('small');
    badge.id = 'site-build-version';
    badge.className = 'site-build-version';
    badge.textContent = version;
    badge.setAttribute('aria-label', `網站部署版本 ${version}`);
    document.body.appendChild(badge);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})();
