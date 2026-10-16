(() => {
  'use strict';

  const MEMBERSHIP_TIER_STYLE_KEYS = Object.freeze(['forest', 'midnight', 'ocean', 'sunset', 'lavender', 'rose', 'gold', 'platinum', 'mint', 'cherry']);

  // The member client keeps its raw tier field separate from the visible
  // membership-progress label. Booking used the same DOM node for both,
  // which caused app.js and MembershipProgress to overwrite each other on
  // every realtime refresh. Split those targets before app.js binds them.
  function ensureSeparateTierTargets() {
    const root = document.getElementById('membershipProgress');
    const visible = root?.querySelector('[data-membership-current-tier]');
    if (!visible) return;

    if (visible.id === 'memberTier') visible.removeAttribute('id');
    if (!document.getElementById('memberTier')) {
      const rawTier = document.createElement('span');
      rawTier.id = 'memberTier';
      rawTier.className = 'hidden';
      rawTier.setAttribute('aria-hidden', 'true');
      root.before(rawTier);
    }
  }

  function wholeMinutes(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  function formatMinutes(value) {
    return `${wholeMinutes(value)} 分鐘`;
  }

  function progressForProfile(profile) {
    const safeProfile = profile && typeof profile === 'object' ? profile : {};
    const raw = safeProfile.tierProgress && typeof safeProfile.tierProgress === 'object' ? safeProfile.tierProgress : {};
    const serviceMinutesTotal = wholeMinutes(raw.serviceMinutesTotal === undefined ? safeProfile.serviceMinutesTotal : raw.serviceMinutesTotal);
    const currentRequiredServiceMinutes = wholeMinutes(raw.currentRequiredServiceMinutes);
    const nextRequiredServiceMinutes = Math.floor(Number(raw.nextRequiredServiceMinutes));
    const nextTierLabel = String(raw.nextTierLabel || '').trim();
    const hasNextTier = Boolean(nextTierLabel && Number.isInteger(nextRequiredServiceMinutes) && nextRequiredServiceMinutes > currentRequiredServiceMinutes);
    const remainingServiceMinutes = hasNextTier ? wholeMinutes(raw.remainingServiceMinutes === undefined ? nextRequiredServiceMinutes - serviceMinutesTotal : raw.remainingServiceMinutes) : 0;
    const percent = hasNextTier
      ? Math.min(100, Math.max(0, (serviceMinutesTotal - currentRequiredServiceMinutes) / (nextRequiredServiceMinutes - currentRequiredServiceMinutes) * 100))
      : raw.isHighestTier ? 100 : 0;
    return { serviceMinutesTotal, nextTierLabel, nextRequiredServiceMinutes, remainingServiceMinutes, hasNextTier, isHighestTier: Boolean(raw.isHighestTier), percent };
  }

  function setText(root, selector, value) {
    const element = root.querySelector(selector);
    if (element && element.textContent !== value) element.textContent = value;
  }

  function tierStyleKeyForProfile(profile) {
    const styleKey = String(profile && profile.tierStyleKey || '').trim();
    return MEMBERSHIP_TIER_STYLE_KEYS.includes(styleKey) ? styleKey : 'forest';
  }

  function applyTierStyle(root, profile) {
    if (typeof root.setAttribute !== 'function') return;
    const next = tierStyleKeyForProfile(profile);
    if (root.getAttribute('data-membership-tier-style') !== next) root.setAttribute('data-membership-tier-style', next);
  }

  function render(root, profile) {
    if (!root || typeof root.querySelector !== 'function') return;
    ensureSeparateTierTargets();
    applyTierStyle(root, profile);
    const progress = progressForProfile(profile);
    const currentTier = String(profile && profile.tier || '一般會員');
    const currentTierText = `目前會員階級：${currentTier}`;
    let summaryText = `累積 ${formatMinutes(progress.serviceMinutesTotal)}・下一階段資料載入中`;
    let remainingText = '下一階段資料載入中';

    if (progress.hasNextTier) {
      summaryText = `累積 ${formatMinutes(progress.serviceMinutesTotal)}・下一階段 ${progress.nextTierLabel} ${formatMinutes(progress.nextRequiredServiceMinutes)}`;
      remainingText = `距離 ${progress.nextTierLabel} 還需要 ${formatMinutes(progress.remainingServiceMinutes)}`;
    } else if (progress.isHighestTier) {
      summaryText = `累積 ${formatMinutes(progress.serviceMinutesTotal)}・已達最高會員階級`;
      remainingText = '已達最高會員階級';
    }

    const roundedPercent = Math.round(progress.percent);
    setText(root, '[data-membership-current-tier]', currentTierText);
    setText(root, '[data-membership-summary]', summaryText);
    setText(root, '[data-membership-remaining]', remainingText);
    const track = root.querySelector('[data-membership-progress-track]');
    const bar = root.querySelector('[data-membership-progress-bar]');
    const width = `${roundedPercent}%`;
    if (bar && bar.style.width !== width) bar.style.width = width;
    if (track) {
      if (track.getAttribute('aria-valuenow') !== String(roundedPercent)) track.setAttribute('aria-valuenow', String(roundedPercent));
      if (track.getAttribute('aria-valuetext') !== remainingText) track.setAttribute('aria-valuetext', remainingText);
    }
  }

  ensureSeparateTierTargets();
  window.MembershipProgress = Object.freeze({ render });
})();
