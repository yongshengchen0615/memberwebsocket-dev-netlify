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
    row(options.history ? '使用時間' : '活動期間', options.history ? String(options.usedAt || '') : `${ticket.startsOn || '即日起'} — ${ticket.endsOn || '不限期'}`);
    if (!options.history) {
      const quota = Number(ticket.quota || 0);
      const claimed = Math.max(0, Number(ticket.claimedCount || 0));
      row(options.fixed ? '發放方式' : '限量張數', options.fixed ? '系統自動發放' : quota > 0 ? `${quota} 張（剩餘 ${Math.max(0, quota - claimed)} 張）` : '不限量');
      const labels = ticket.allowedTierLabels || (ticket.allowedTierKeys || []).map(key => tiers[key]).filter(Boolean);
      row('適用等級', labels.length ? labels.join('、') : '全部會員等級');
    }
    card.append(head, title, copy, meta);
    return card;
  }
  window.EventTicketUI = Object.freeze({ create });
})();
