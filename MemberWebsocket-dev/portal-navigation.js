(() => {
  'use strict';
  // Navigation is not authorization: every destination verifies LINE identity
  // and its own server-side role/tenant permissions.
  const surface = document.documentElement.dataset.portalSurface;
  if (!['platform', 'admin', 'member'].includes(surface)) return;
  const links = [
    { id: 'platform', title: '總管理員', url: '/platform/' },
    { id: 'admin', title: '一般管理員', url: '/admin/' },
    { id: 'member', title: '用戶端', url: '/member/' },
  ];
  function mount() {
    if (document.getElementById('unifiedPortalNav')) return;
    const nav = document.createElement('nav');
    nav.id = 'unifiedPortalNav';
    nav.className = 'unified-portal-nav';
    nav.setAttribute('aria-label', '系統入口切換（各入口需獨立驗證）');
    const caption = document.createElement('span');
    caption.className = 'unified-portal-caption';
    caption.textContent = '系統入口';
    nav.append(caption);
    for (const { id, title, url } of links) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = title;
      a.className = 'unified-portal-link';
      if (id === surface) {
        a.setAttribute('aria-current', 'page');
      }
      nav.append(a);
    }
    const target = document.body.querySelector('main') || document.body.firstElementChild;
    if (target) document.body.insertBefore(nav, target);
    else document.body.append(nav);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
