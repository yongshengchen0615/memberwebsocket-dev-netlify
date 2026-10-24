/* Progressive enhancement: reuses the already-authorized tabs; never grants access. */
(() => {
  'use strict';
  window.addEventListener('DOMContentLoaded', () => {
    const workspace = document.getElementById('adminView');
    const shortcuts = document.getElementById('adminQuickActions');
    if (!workspace || !shortcuts) return;
    const buttons = [...shortcuts.querySelectorAll('button[data-admin-quick-tab]')];
    const targetFor = button => document.getElementById(button.dataset.adminQuickTab);
    const targetAvailable = target => Boolean(target && !target.hidden && !target.disabled &&
      target.getAttribute('aria-hidden') !== 'true' && !target.classList.contains('hidden') &&
      target.getClientRects().length);
    const sync = () => {
      const workspaceReady = !workspace.hidden && !workspace.classList.contains('hidden') &&
        workspace.getClientRects().length > 0;
      let count = 0;
      buttons.forEach(button => {
        const target = targetFor(button);
        const available = workspaceReady && targetAvailable(target);
        if (button.hidden === available) button.hidden = !available;
        if (button.disabled === available) button.disabled = !available;
        const active = available && target.getAttribute('aria-selected') === 'true';
        if (active && button.getAttribute('aria-current') !== 'location') {
          button.setAttribute('aria-current', 'location');
        } else if (!active && button.hasAttribute('aria-current')) {
          button.removeAttribute('aria-current');
        }
        if (available) count += 1;
      });
      if (shortcuts.hidden === (count > 0)) shortcuts.hidden = count === 0;
    };
    shortcuts.addEventListener('click', event => {
      const button = event.target instanceof Element
        ? event.target.closest('button[data-admin-quick-tab]') : null;
      if (!button || button.disabled || button.hidden) return;
      const target = document.getElementById(button.dataset.adminQuickTab);
      if (!targetAvailable(target) || workspace.classList.contains('hidden')) {
        sync();
        return;
      }
      target.click(); // Existing handler performs the real tab transition.
      if (target.getAttribute('aria-selected') === 'true') {
        target.focus({ preventScroll: true });
        const panel = document.getElementById(target.getAttribute('aria-controls'));
        panel?.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    });
    const observer = new MutationObserver(sync);
    observer.observe(workspace, { attributes: true, attributeFilter: ['hidden', 'class'] });
    // Observe the live navigation: feature tabs may be mounted or replaced after bootstrap.
    const navigation = workspace.querySelector('.surface-nav');
    if (navigation) observer.observe(navigation, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'disabled', 'class', 'aria-hidden', 'aria-selected'],
    });
    window.addEventListener('pageshow', sync);
    sync();
  });
})();
