(() => {
  'use strict';
  // Presentation only: callers own eligibility, balances, selection and requests.
  const POINT_CARD_STYLE_KEYS = new Set(['citrus', 'coral', 'lagoon', 'skyline', 'violet', 'berry', 'cocoa', 'lime', 'denim', 'peach']);
  const LEGACY_POINT_CARD_STYLE_MAP = Object.freeze({ forest: 'lagoon', midnight: 'skyline', ocean: 'denim', sunset: 'coral', lavender: 'violet', rose: 'berry', gold: 'citrus', platinum: 'cocoa', mint: 'lime', cherry: 'peach' });
  function pointCardStyleKey(value) {
    const key = String(value || '').trim().toLowerCase();
    return POINT_CARD_STYLE_KEYS.has(key) ? key : (LEGACY_POINT_CARD_STYLE_MAP[key] || 'citrus');
  }
  function pointTicketDetails({ cardTitle, pointCost, pointBalance }) {
    const list = document.createElement('dl');
    list.className = 'ticket-cost-cards';
    for (const [label, value, modifier] of [
      ['兌換需扣', `${Math.max(0, Number(pointCost) || 0)} 點`, 'is-cost'],
      ['目前可用', `${Math.max(0, Number(pointBalance) || 0)} 點`, 'is-balance'],
      ['來源集點卡', String(cardTitle || '集點卡'), 'is-source'],
    ]) {
      const row = document.createElement('div');
      row.className = `ticket-cost-card ${modifier}`;
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      row.append(term, detail);
      list.append(row);
    }
    return list;
  }
  window.MemberUI = Object.freeze({ pointTicketDetails, pointCardStyleKey });
})();
