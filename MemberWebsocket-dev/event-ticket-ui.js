(() => {
  'use strict';
  const types = { lottery: '活動抽獎券', referral: '好友邀請券', membership_join: '加入會員券' };
  const tiers = { general: '一般會員', silver: '銀級會員', gold: '金級會員', platinum: '白金會員' };
  function create(ticket = {}, options = {}) {
    const card = document.createElement('article');
    card.className = 'event-ticket' + (options.history ? ' used-ticket' : '');
    card.style.setProperty('--ticket-accent', /^#[0-9a-f]{6}$/i.test(String(ticket.accent || '')) ? ticket.accent : '#d86e50');
    const head = document.createElement('div'); head.className = 'event-ticket-head';
    const type = document.createElement('span'); type.className = 'event-ticket-type';
    type.textContent = options.fixed ? '固定票券' : types[ticket.ticketType] || '活動優惠券';
    const badge = document.createElement('span'); badge.className = 'event-ticket-state';
    if (/^[a-z-]+$/.test(options.stateClass || '')) badge.classList.add(options.stateClass);
    badge.textContent = options.stateLabel || '活動票券'; head.append(type, badge);
    const title = document.createElement('h3'); title.textContent = String(ticket.title || '活動票券');
    const copy = document.createElement('p'); copy.className = 'event-ticket-description';
    copy.textContent = String(ticket.description || '查看活動內容與使用說明。');
    const meta = document.createElement('div'); meta.className = 'event-ticket-meta';
    const row = (label, value) => {
      const line = document.createElement('span'), name = document.createElement('strong');
      name.textContent = label; line.append(name, document.createTextNode('　' + value)); meta.append(line);
    };
    const relative = ['relative', 'both'].includes(String(ticket.validityMode || ''));
    const expiry = options.expiresAt ? new Date(options.expiresAt) : null;
    const expiryLabel = expiry && !Number.isNaN(expiry.getTime())
      ? new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(expiry) : '';
    row(options.history ? '使用時間' : relative ? '票券期限' : '活動期間',
      options.history ? String(options.usedAt || '')
        : relative ? `獲得後 ${ticket.validityDays} 天有效${expiryLabel ? ' · 到期 ' + expiryLabel : ''}`
        : `${ticket.startsOn || '即日起'} — ${ticket.endsOn || '不限期'}`);
    if (!options.history) {
      const quota = Number(ticket.quota || 0);
      const used = Math.max(0, Number(ticket.usedCount || 0));
      row(options.fixed ? '發放方式' : '使用數量上限', options.fixed ? '系統自動發放' : quota > 0 ? `${quota} 次（已使用 ${used} 次，剩餘 ${Math.max(0, quota - used)} 次）` : `不限量（已使用 ${used} 次）`);
      const labels = ticket.allowedTierLabels || (ticket.allowedTierKeys || []).map(key => tiers[key]).filter(Boolean);
      row('適用等級', labels.length ? labels.join('、') : '全部會員等級');
      if (options.showServiceRequirement && String(ticket.requiredServiceRequirementLabel || '').trim()) {
        row('預約項目條件', String(ticket.requiredServiceRequirementLabel).trim());
      }
      if (options.showAmountRequirement && String(ticket.minBookingAmountLabel || '').trim()) {
        row('金額使用條件', String(ticket.minBookingAmountLabel).trim());
      }
      if (options.showPartyRequirement !== false && String(ticket.minBookingPartySizeLabel || '').trim()) {
        row('預約人數條件', String(ticket.minBookingPartySizeLabel).trim());
      }
    }
    if (options.giftTransferredAt) {
      row('轉贈者', String(options.giftFromName || '好友'));
      row('轉贈時間', String(options.giftTransferredAt));
    }
    card.append(head, title, copy, meta);
    return card;
  }
  window.EventTicketUI = Object.freeze({ create });
})();
