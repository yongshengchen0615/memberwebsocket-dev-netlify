(() => {
  'use strict';

  const TIERS = Object.freeze([
    { key: 'general', label: '一般', aliases: ['一般會員', '一般'] },
    { key: 'silver', label: '銀級', aliases: ['銀級會員', '銀級'] },
    { key: 'gold', label: '金級', aliases: ['金級會員', '金級'] },
    { key: 'platinum', label: '白金', aliases: ['白金會員', '白金'] },
  ]);

  function normalize(value) {
    return String(value || '')
      .replace(/^目前會員階級[：:]?\s*/, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function currentTierIndex(root) {
    const text = normalize(root.querySelector('[data-membership-current-tier]')?.textContent);
    if (!text || text.includes('載入中')) return -1;
    return TIERS.findIndex((tier) => tier.aliases.some((alias) => text === normalize(alias)));
  }

  function ensureRail(root) {
    let rail = root.querySelector('[data-membership-milestones]');
    if (rail) return rail;

    rail = document.createElement('div');
    rail.className = 'membership-milestones';
    rail.dataset.membershipMilestones = '';
    rail.setAttribute('aria-label', '會員階級里程碑');

    TIERS.forEach((tier) => {
      const item = document.createElement('span');
      item.className = 'membership-milestone';
      item.dataset.membershipMilestone = tier.key;
      item.textContent = tier.label;
      rail.appendChild(item);
    });

    const track = root.querySelector('[data-membership-progress-track]');
    if (track?.parentNode === root) track.insertAdjacentElement('afterend', rail);
    else root.appendChild(rail);
    return rail;
  }

  function render(root) {
    const rail = ensureRail(root);
    const current = currentTierIndex(root);
    root.dataset.membershipMilestoneIndex = String(current);

    rail.querySelectorAll('[data-membership-milestone]').forEach((item, index) => {
      const reached = current >= 0 && index <= current;
      const active = current === index;
      item.classList.toggle('is-reached', reached);
      item.classList.toggle('is-current', active);
      if (active) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function bind(root) {
    render(root);
    const source = root.querySelector('[data-membership-current-tier]');
    if (!source || typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(() => render(root));
    observer.observe(source, { childList: true, subtree: true, characterData: true });
  }

  function boot() {
    document.querySelectorAll('.membership-progress').forEach(bind);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
