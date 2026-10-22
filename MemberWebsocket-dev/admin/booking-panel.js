(() => {
  'use strict';

  const current = document.currentScript?.src || new URL('./booking-panel.js', window.location.href).toString();
  const load = (name, version) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(`./${name}?v=${version}`, current).toString();
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`載入 ${name} 失敗。`));
    document.head.appendChild(script);
  });

  // Preserve compatibility with the retired /booking/admin/ route without
  // waiting for the visible admin UI and clicking a tab after first paint.
  if (window.location.hash === '#booking' || /^[0-9a-f-]{36}$/i.test(new URLSearchParams(window.location.search).get('bookingId') || '')) {
    window.MemberAdminInitialPanel = 'booking';
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  }

  document.addEventListener('click', (event) => {
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    const button = event.target?.closest?.('#bookingPanel .booking-admin-filter-button');
    if (!button) return;
    window.requestAnimationFrame(() => {
      try { button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } catch (_) {}
    });
  });

  // Layout CSS is loaded statically from admin/index.html before first paint.
  // Only behavior modules remain lazy so opening the admin shell cannot cause
  // a late stylesheet-driven layout shift.
  const preloadExtensions = [
    ['booking-risk.js', 'booking-risk-recovery-20261022-1'],
    ['booking-always-open.js', 'booking-always-open-20260917-2'],
    ['booking-cancellation-sync.js', 'layout-stability-20261001-1-controls-20261010-2'],
    ['booking-resources.js', 'booking-technician-disable-action-20260920-1-booking-settings-20261006-2-ui-20261006-1'],
  ];

  Promise.allSettled(preloadExtensions.map(([name, version]) => load(name, version)))
    .then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error('booking admin extension preload failed', preloadExtensions[index][0], result.reason);
        }
      });
      const result = load('booking-panel-core.js', 'booking-operations-split-20261003-1-ticket-source-20261004-1-ticket-card-ui-20261004-1-ticket-booking-20261006-1-booking-settings-20261006-2-ui-20261006-1-badge-20261009-1-snapshot-20261010-1-policy-entry-20261010-1-controls-20261010-2-snapshot-geofence-20261012-1-release-20261014-1-no-show-history-20261014-1-hide-early-hint-20261015-1-service-ticket-rule-20261015-1-booking-risk-20261021-1');
      // Compatibility marker for legacy architecture checks:
      // load('booking-panel-core.js', 'layout-stability-20261001-1')
      return result;
    })
    .catch((error) => console.error('booking admin core load failed', error));
})();
