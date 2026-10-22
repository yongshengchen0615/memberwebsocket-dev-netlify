/* Progressive enhancement: reuses the already-authorized tabs; never grants access. */
(() => {
  'use strict';
  window.addEventListener('DOMContentLoaded', () => {
    const workspace = document.getElementById('adminView');
    const shortcuts = document.getElementById('adminQuickActions');
    if (!workspace || !shortcuts) return;
    const buttons = [...shortcuts.querySelectorAll('button[data-admin-quick-tab]')];
    const targets = buttons.map(button => document.getElementById(button.dataset.adminQuickTab));
    const targetAvailable = target => Boolean(target && !target.hidden && !target.disabled &&
      target.getAttribute('aria-hidden') !== 'true' && !target.classList.contains('hidden') &&
      target.getClientRects().length);
    const sync = () => {
      const workspaceReady = !workspace.hidden && !workspace.classList.contains('hidden') &&
        workspace.getClientRects().length > 0;
      let count = 0;
      buttons.forEach((button, index) => {
        const available = workspaceReady && targetAvailable(targets[index]);
        if (button.hidden === available) button.hidden = !available;
        if (button.disabled === available) button.disabled = !available;
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
    targets.filter(Boolean).forEach(target => observer.observe(target, {
      attributes: true, attributeFilter: ['hidden', 'disabled', 'class', 'aria-hidden'],
    }));
    window.addEventListener('pageshow', sync);
    sync();
  });
})();
