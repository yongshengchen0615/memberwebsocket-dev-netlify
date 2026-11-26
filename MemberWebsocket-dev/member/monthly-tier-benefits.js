(() => {
  'use strict';

  // Catalogue preview only. Ticket ownership and redemption belong to their
  // authenticated server-side workflows, never to this card.
  let generation = 0;
  let pendingKey = '';
  let pendingPromise = null;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function shortDate(value) {
    const date = String(value || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : '';
  }

  function dateLabel(item) {
    const from = shortDate(item.startsOn);
    const until = shortDate(item.endsOn);
    if (from && until) return from === until ? from : `${from}–${until}`;
    if (from) return `${from} 起`;
    if (until) return `至 ${until}`;
    return '依活動公告';
  }

  function tierSection(tier, currentTierKey) {
    const section = element('section', 'member-monthly-tier');
    section.dataset.tierKey = String(tier.key || '');
    if (tier.key === currentTierKey) section.classList.add('is-current');
    const heading = element('div', 'member-monthly-tier-heading');
    heading.append(element('h4', '', tier.label || '會員階級'));
    if (tier.key === currentTierKey) heading.append(element('span', 'member-monthly-current-tag', '目前階級'));
    section.append(heading);
    const items = Array.isArray(tier.offers) ? tier.offers : [];
    if (!items.length) {
      section.append(element('p', 'member-monthly-tier-empty', '本月尚無公開優惠'));
      return section;
    }
    const list = element('ul', 'member-monthly-tier-list');
    for (const offer of items) {
      const li = element('li', 'member-monthly-offer');
      const category = offer.kind === 'ticket' ? '票券' : '會員活動';
      const top = element('div', 'member-monthly-offer-top');
      top.append(element('span', 'member-monthly-offer-kind', category),
        element('span', 'member-monthly-offer-date', dateLabel(offer)));
      li.append(top, element('strong', 'member-monthly-offer-title', offer.title || '未命名活動'));
      list.append(li);
    }
    section.append(list);
    return section;
  }

  function render(root, data, currentTierKey) {
    const target = root.querySelector('[data-member-monthly-tier-overview]');
    if (!target) return;
    const tiers = Array.isArray(data?.tiers) ? data.tiers : [];
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(data?.month || '')) ? data.month : '';
    const heading = root.querySelector('[data-member-monthly-tier-month]');
    if (heading) heading.textContent = month ? `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月` : '本月';
    target.replaceChildren(...tiers.map((tier) => tierSection(tier, currentTierKey)));
    root.querySelector('[data-member-monthly-tier-status]').textContent =
      tiers.length ? '各階級優惠內容已更新' : '本月尚無階級優惠資料';
  }

  function refresh(root, config, idToken, profile) {
    if (!root?.querySelector || !config || !idToken) return Promise.resolve();
    const target = root.querySelector('[data-member-monthly-tier-overview]');
    const status = root.querySelector('[data-member-monthly-tier-status]');
    if (!target || !status) return Promise.resolve();
    const button = root.querySelector('[data-member-monthly-tier-reload]');
    if (button) button.onclick = () => { void refresh(root, config, idToken, profile); };
    if (String(profile?.status || '').toLowerCase() !== 'active'
      || profile?.membershipRequired || !profile?.profileComplete) {
      generation += 1;
      pendingKey = '';
      pendingPromise = null;
      target.replaceChildren();
      target.setAttribute('aria-busy', 'false');
      if (button) button.disabled = false;
      status.textContent = '會員資格啟用後即可查看當月優惠。';
      return Promise.resolve();
    }
    const month = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).format(new Date());
    const key = JSON.stringify([config.supabaseUrl, window.BusinessContext?.slug || config.business || '', profile.lineUserId, profile.tierKey, month]);
    // Coalesce only simultaneous identical reads. Profile/tier updates must
    // fetch fresh server data instead of showing stale long-lived snapshots.
    if (key === pendingKey && pendingPromise) return pendingPromise;
    target.replaceChildren();
    const request = ++generation;
    status.textContent = '正在載入當月各階級優惠…';
    target.setAttribute('aria-busy', 'true');
    if (button) button.disabled = true;
    const promise = window.MemberSystem.request(config, 'member', idToken, 'user.member.monthly-tier-benefits')
      .then((data) => {
        if (request !== generation) return;
        if (!data || !Array.isArray(data.tiers)) throw Error('優惠清單格式不正確。');
        render(root, data, String(profile.tierKey || 'general'));
      })
      .catch((error) => {
        if (request !== generation) return;
        status.textContent = error?.code === 'FEATURE_DISABLED'
          ? '商家尚未開放階級優惠預覽。'
          : '當月優惠載入失敗，請點擊「更新」重試。';
      })
      .finally(() => {
        if (request === generation) {
          target.setAttribute('aria-busy', 'false');
          if (button) button.disabled = false;
        }
        if (pendingPromise === promise) {
          pendingPromise = null;
          pendingKey = '';
        }
      });
    pendingKey = key;
    pendingPromise = promise;
    return promise;
  }

  window.MemberMonthlyTierBenefits = Object.freeze({ refresh });
})();
