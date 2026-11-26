(() => {
  'use strict';
  // Read-only: never grant, claim, transfer or redeem tickets from this widget.
  const states = new WeakMap();
  const surfaces = new Set(['member', 'points', 'event', 'calendar', 'booking']);
  const STALE_MS = 120000;
  const CARD_STYLE_KEYS = new Set(['forest','midnight','ocean','sunset','lavender','rose','gold','platinum','mint','cherry']);
  function cardStyle(value) {
    const key = String(value || '');
    return CARD_STYLE_KEYS.has(key) ? key : 'forest';
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function shortDate(value) {
    const date = String(value || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(5, 7) + '/' + date.slice(8, 10) : '';
  }

  function dateLabel(item) {
    const start = shortDate(item.startsOn);
    const end = shortDate(item.endsOn);
    if (start && end) return start === end ? start : start + '–' + end;
    if (start) return start + ' 起';
    if (end) return '至 ' + end;
    return '依活動公告';
  }

  function tierSection(tier, currentTier) {
    const section = element('section', 'member-monthly-tier');
    section.dataset.tierKey = String(tier.key || '');
    section.dataset.membershipTierStyle = cardStyle(tier.styleKey);
    if (tier.key === currentTier) section.classList.add('is-current');
    const heading = element('div', 'member-monthly-tier-heading');
    heading.append(element('h4', '', tier.label || '會員階級'));
    if (tier.key === currentTier) heading.append(element('span', 'member-monthly-current-tag', '目前階級'));
    section.append(heading);
    const offers = Array.isArray(tier.offers) ? tier.offers : [];
    if (!offers.length) {
      section.append(element('p', 'member-monthly-tier-empty', '本月無可查看的優惠'));
      return section;
    }
    const list = element('ul', 'member-monthly-tier-list');
    for (const offer of offers) {
      const item = element('li', 'member-monthly-offer');
      item.append(
        element('span', 'member-monthly-offer-kind', offer.kind === 'ticket' ? '票券' : '活動'),
        element('strong', 'member-monthly-offer-title', offer.title || '未命名活動'),
        element('small', 'member-monthly-offer-date', dateLabel(offer))
      );
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function render(root, state) {
    const data = state.data;
    const tiers = Array.isArray(data && data.tiers) ? data.tiers : [];
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(data && data.month || '')) ? data.month : '';
    const monthNode = root.querySelector('[data-member-monthly-tier-month]');
    if (monthNode) monthNode.textContent = month ? month.slice(0,4) + ' 年 ' + Number(month.slice(5)) + ' 月' : '本月';
    const teaser = root.querySelector('[data-member-monthly-tier-teaser]');
    if (teaser) teaser.textContent = root.open ? '收合內容' : '展開查看';
    const currentTier = String(state.profile.tierKey || 'general');
    if (!tiers.some(tier => tier.key === state.selected)) state.selected = currentTier;
    if (!tiers.some(tier => tier.key === state.selected)) state.selected = tiers[0] && tiers[0].key || 'general';
    const tabTarget = root.querySelector('[data-member-monthly-tier-tabs]');
    if (tabTarget) {
      const buttons = tiers.map(tier => {
        const count = Array.isArray(tier.offers) ? tier.offers.length : 0;
        const fullLabel = String(tier.label || '階級');
        const shortLabel = fullLabel.replace(/會員$/, '');
        const button = element('button', 'member-monthly-tab');
        button.type = 'button';
        button.dataset.tierKey = String(tier.key || '');
        button.dataset.membershipTierStyle = cardStyle(tier.styleKey);
        button.setAttribute('aria-pressed', String(tier.key === state.selected));
        button.setAttribute('aria-label', fullLabel + '，' + count + ' 項優惠' + (tier.key === currentTier ? '，目前會員階級' : ''));
        if (tier.key === currentTier) button.classList.add('is-current');
        button.append(element('span', 'member-monthly-tab-label', shortLabel), element('span', 'member-monthly-tab-count', count));
        button.onclick = () => {
          state.selected = String(tier.key || '');
          render(root, state);
        };
        return button;
      });
      tabTarget.replaceChildren(...buttons);
    }
    const target = root.querySelector('[data-member-monthly-tier-overview]');
    const selected = tiers.find(tier => tier.key === state.selected);
    if (target) target.replaceChildren(...(selected ? [tierSection(selected, currentTier)] : []));
    const status = root.querySelector('[data-member-monthly-tier-status]');
    if (status) status.textContent = tiers.length ? '顯示可查看的公開優惠；選擇階級切換' : '本月尚無階級優惠資料';
  }

  function context(root, config, idToken, profile, surface) {
    if (!root || typeof root.querySelector !== 'function') return null;
    let state = states.get(root);
    if (!state) {
      state = {generation:0, key:'', ready:false, loadedKey:'', loadedAt:0, pendingKey:'', pendingPromise:null, selected:'', data:null};
      states.set(root, state);
      if (typeof root.addEventListener === 'function') {
        root.addEventListener('toggle', () => {
          const teaser = root.querySelector('[data-member-monthly-tier-teaser]');
          if (teaser) teaser.textContent = root.open ? '收合內容' : '展開查看';
          if (root.open && state.ready && (state.loadedKey !== state.key || Date.now() - state.loadedAt > STALE_MS)) {
            void load(root, state);
          }
        });
      }
      const button = root.querySelector('[data-member-monthly-tier-reload]');
      if (button) button.onclick = () => { if (state.ready) void load(root, state); };
    }
    const clientType = String(surface || 'member');
    const permitted = surfaces.has(clientType) && Boolean(config && idToken && profile && profile.lineUserId)
      && String(profile?.status || '').toLowerCase() === 'active'
      && profile?.membershipRequired !== true && profile?.profileComplete !== false;
    const business = String(window.BusinessContext?.slug || config?.business || '');
    const currentMonth = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date());
    const key = permitted ? JSON.stringify([config.supabaseUrl, business, idToken, profile.lineUserId, profile.tierKey, clientType, currentMonth]) : '';
    if (state.key !== key || !permitted) {
      state.generation += 1;
      state.key = key;
      state.data = null;
      state.loadedKey = '';
      state.pendingKey = '';
      state.pendingPromise = null;
      state.loadedAt = 0;
      state.selected = String(profile?.tierKey || 'general');
      const target = root.querySelector('[data-member-monthly-tier-overview]');
      const tabs = root.querySelector('[data-member-monthly-tier-tabs]');
      const status = root.querySelector('[data-member-monthly-tier-status]');
      const teaser = root.querySelector('[data-member-monthly-tier-teaser]');
      if (target) target.replaceChildren();
      if (tabs) tabs.replaceChildren();
      if (status) status.textContent = permitted ? '展開後載入當月優惠' : '會員資格啟用後可查看當月優惠';
      if (teaser) teaser.textContent = root.open ? '收合內容' : '展開查看';
      const button = root.querySelector('[data-member-monthly-tier-reload]');
      if (button) button.disabled = false;
    }
    state.ready = permitted;
    state.config = config;
    state.idToken = idToken;
    state.profile = profile;
    state.clientType = clientType;
    state.business = business;
    root.hidden = !permitted;
    if (!permitted && root.open) root.open = false;
    return state;
  }

  function load(root, state) {
    if (!state || !state.ready) return Promise.resolve();
    if (state.pendingKey === state.key && state.pendingPromise) return state.pendingPromise;
    const request = ++state.generation;
    const status = root.querySelector('[data-member-monthly-tier-status]');
    const target = root.querySelector('[data-member-monthly-tier-overview]');
    const tabs = root.querySelector('[data-member-monthly-tier-tabs]');
    const button = root.querySelector('[data-member-monthly-tier-reload]');
    if (target) target.replaceChildren();
    if (tabs) tabs.replaceChildren();
    if (status) status.textContent = '正在載入本月優惠…';
    if (target) target.setAttribute('aria-busy', 'true');
    if (button) button.disabled = true;
    let response;
    try {
      response = state.clientType === 'booking'
        ? window.BookingSystem.monthlyTierBenefits(state.config, state.idToken)
        : window.MemberSystem.request(state.config, state.clientType, state.idToken, 'user.member.monthly-tier-benefits');
    } catch (error) { response = Promise.reject(error); }
    const key = state.key;
    const business = state.business;
    const promise = Promise.resolve(response).then(data => {
      if (request !== state.generation || window.BusinessContext?.slug && window.BusinessContext.slug !== business) return;
      if (!data || !Array.isArray(data.tiers)) throw Error('優惠清單格式不正確');
      state.data = data;
      state.loadedKey = key;
      state.loadedAt = Date.now();
      render(root, state);
    }).catch(error => {
      if (request !== state.generation) return;
      state.data = null;
      state.loadedKey = '';
      if (status) status.textContent = error?.code === 'FEATURE_DISABLED'
        ? '商家尚未開放階級優惠預覽'
        : '當月優惠載入失敗，請點擊「更新」重試。';
    }).finally(() => {
      if (request === state.generation) {
        if (target) target.setAttribute('aria-busy', 'false');
        if (button) button.disabled = false;
      }
      if (state.pendingPromise === promise) { state.pendingPromise = null; state.pendingKey = ''; }
    });
    state.pendingKey = key;
    state.pendingPromise = promise;
    return promise;
  }

  function bind(root, config, idToken, profile, surface = 'member') {
    const state = context(root, config, idToken, profile, surface);
    if (state?.ready && root.open && (state.loadedKey !== state.key || Date.now() - state.loadedAt > STALE_MS)) {
      return load(root, state);
    }
    return Promise.resolve();
  }

  // Explicit refresh stays callable by QA and the refresh button; portal boot
  // calls bind() instead, so closed widgets cost no extra API request.
  function refresh(root, config, idToken, profile, surface = 'member') {
    return load(root, context(root, config, idToken, profile, surface));
  }

  window.MemberMonthlyTierBenefits = Object.freeze({bind, refresh});
})();
