(() => {
  'use strict';

  const state = {
    receiptByBooking: new Map(),
    loading: false,
    refreshQueued: false,
    realtimeTimer: null,
    queueObserver: null,
    queueObserverTarget: null,
  };

  function session() {
    return window.MemberSystem?.getSession?.('admin') || null;
  }

  function ensureViewer() {
    let modal = document.getElementById('adminBookingReceiptModal');
    if (modal) return modal;
    modal = document.createElement('section');
    modal.id = 'adminBookingReceiptModal';
    modal.className = 'admin-booking-receipt-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'adminBookingReceiptTitle');
    modal.innerHTML = `
      <div class="admin-booking-receipt-card">
        <div class="admin-booking-receipt-heading">
          <div><p class="kicker">Receipt snapshot</p><h2 id="adminBookingReceiptTitle">預約收據快照</h2></div>
          <button id="adminBookingReceiptClose" class="close-button" type="button" aria-label="關閉">×</button>
        </div>
        <p id="adminBookingReceiptMeta" class="admin-booking-receipt-meta"></p>
        <div id="adminBookingReceiptSummary" class="admin-booking-receipt-summary hidden"></div>
        <div id="adminBookingReceiptLoading" class="admin-booking-receipt-loading">正在建立安全檢視連結…</div>
        <img id="adminBookingReceiptImage" class="admin-booking-receipt-image hidden" alt="會員拍攝的預約收據快照">
        <p id="adminBookingReceiptMessage" class="form-message hidden" role="alert"></p>
      </div>`;
    document.body.append(modal);
    modal.querySelector('#adminBookingReceiptClose').addEventListener('click', closeViewer);
    modal.addEventListener('click', (event) => { if (event.target === modal) closeViewer(); });
    return modal;
  }

  function closeViewer() {
    const modal = document.getElementById('adminBookingReceiptModal');
    if (!modal) return;
    const image = modal.querySelector('#adminBookingReceiptImage');
    if (image) {
      image.removeAttribute('src');
      image.classList.add('hidden');
    }
    modal.classList.add('hidden');
  }

  function renderBookingSummary(host, booking) {
    if (!host) return;
    host.replaceChildren();
    if (!booking || typeof booking !== 'object') {
      host.classList.add('hidden');
      return;
    }

    const member = booking.member && typeof booking.member === 'object' ? booking.member : {};
    const memberName = String(member.displayName || '').trim()
      || [String(member.surname || '').trim(), String(member.salutation || '').trim()].filter(Boolean).join('')
      || '會員';
    const nextDay = booking.startsNextDay ? '（翌日結束）' : '';
    const rows = [
      ['會員', memberName + (member.memberCode ? ' · ' + member.memberCode : '')],
      ['預約日期', String(booking.bookingDate || '')],
      ['服務時間', String(booking.startTime || '') + '–' + String(booking.endTime || '') + nextDay],
      ['預約狀態', String(booking.status || '')],
    ];

    const list = document.createElement('dl');
    list.className = 'admin-booking-receipt-facts';
    rows.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value || '—';
      list.append(dt, dd);
    });
    host.append(list);

    const items = Array.isArray(booking.items) ? booking.items : [];
    const heading = document.createElement('strong');
    heading.textContent = '預約項目';
    host.append(heading);
    if (!items.length) {
      const empty = document.createElement('p');
      empty.textContent = '此預約沒有可顯示的項目明細。';
      host.append(empty);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'admin-booking-receipt-items';
      items.forEach((item) => {
        const li = document.createElement('li');
        const qty = Math.max(1, Number(item?.quantity || 1));
        li.textContent = String(item?.title || '預約項目') + (qty > 1 ? ' ×' + qty : '');
        ul.append(li);
      });
      host.append(ul);
    }
    host.classList.remove('hidden');
  }

  async function openViewer(bookingId) {
    const currentSession = session();
    if (!currentSession) return;
    const modal = ensureViewer();
    const loading = modal.querySelector('#adminBookingReceiptLoading');
    const image = modal.querySelector('#adminBookingReceiptImage');
    const message = modal.querySelector('#adminBookingReceiptMessage');
    const meta = modal.querySelector('#adminBookingReceiptMeta');
    const summary = modal.querySelector('#adminBookingReceiptSummary');
    const receipt = state.receiptByBooking.get(String(bookingId || ''));

    modal.classList.remove('hidden');
    loading.classList.remove('hidden');
    image.classList.add('hidden');
    message.classList.add('hidden');
    summary?.classList.add('hidden');
    if (summary) summary.replaceChildren();
    meta.textContent = receipt?.status === 'awaiting_review'
      ? '狀態：等待管理端確認'
      : receipt?.boundAt
        ? '完成時間：' + new Date(receipt.boundAt).toLocaleString('zh-Hant-TW')
        : '';

    try {
      const data = await window.MemberSystem.request(
        currentSession.config,
        'admin',
        currentSession.idToken,
        'admin.booking.receipt.url',
        { bookingId: String(bookingId || '') }
      );
      image.src = String(data.signedUrl || '');
      image.classList.remove('hidden');
      renderBookingSummary(summary, data.booking);
      loading.classList.add('hidden');
    } catch (error) {
      loading.classList.add('hidden');
      message.textContent = error?.message || '目前無法載入收據快照。';
      message.classList.remove('hidden');
    }
  }

  function decorateCards() {
    document.querySelectorAll('#bookingAdminQueue [data-booking-id]').forEach((card) => {
      const bookingId = String(card.dataset.bookingId || '');
      if (!bookingId) return;
      card.querySelectorAll('[data-admin-booking-receipt-control]').forEach((node) => node.remove());

      const receipt = state.receiptByBooking.get(bookingId);
      const actions = card.querySelector('.booking-admin-actions');

      if (!receipt || !['awaiting_review', 'bound'].includes(String(receipt.status || ''))) return;
      const host = actions || card;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.adminBookingReceiptControl = '1';
      button.className = 'button button-outline';
      button.textContent = '查看收據快照';
      button.addEventListener('click', () => openViewer(bookingId));
      host.append(button);
    });
  }

  function ensureQueueObserver() {
    const queue = document.getElementById('bookingAdminQueue');
    if (!queue || state.queueObserverTarget === queue || typeof MutationObserver !== 'function') return;

    state.queueObserver?.disconnect();
    state.queueObserverTarget = queue;
    state.queueObserver = new MutationObserver(() => {
      window.setTimeout(decorateCards, 0);
    });
    // Observe only direct booking-card replacement. Receipt controls are added inside
    // each card, so subtree=false prevents the observer from triggering itself.
    state.queueObserver.observe(queue, { childList: true });
    decorateCards();
  }

  async function refresh() {
    if (state.loading) {
      state.refreshQueued = true;
      return;
    }
    const currentSession = session();
    if (!currentSession) return;
    state.loading = true;
    state.refreshQueued = false;
    try {
      const data = await window.MemberSystem.request(
        currentSession.config,
        'admin',
        currentSession.idToken,
        'admin.booking.receipt.list'
      );
      window.dispatchEvent(new CustomEvent('admin:accessible-receipts-updated', { detail: {
        submissions: Array.isArray(data.submissions) ? data.submissions : [],
        records: Array.isArray(data.accessibleRecords) ? data.accessibleRecords : [],
        counts: data.accessibleCounts || null,
      } }));
      state.receiptByBooking.clear();
      (Array.isArray(data.receipts) ? data.receipts : []).forEach((receipt) => {
        state.receiptByBooking.set(String(receipt.bookingId || ''), receipt);
      });
      decorateCards();
    } catch (error) {
      console.warn('admin booking receipt list failed', error);
    } finally {
      state.loading = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        window.setTimeout(() => { void refresh(); }, 0);
      }
    }
  }

  function handleReceiptRealtimeInvalidation(event) {
    const detail = event?.detail || {};
    if (String(detail.clientType || '') !== 'admin') return;
    const scope = String(detail.scope || '');
    const eventType = String(detail.eventType || '');
    if ((scope !== 'all' && scope !== 'admin') || !eventType.startsWith('booking.receipt.')) return;

    if (state.realtimeTimer !== null) window.clearTimeout(state.realtimeTimer);
    state.realtimeTimer = window.setTimeout(() => {
      state.realtimeTimer = null;
      ensureQueueObserver();
      void refresh();
    }, 80);
  }

  window.addEventListener('DOMContentLoaded', () => {
    ensureViewer();
    ensureQueueObserver();
  });
  window.addEventListener('member-system:realtime-invalidation', handleReceiptRealtimeInvalidation);
  window.addEventListener('member-admin-ready', () => {
    ensureQueueObserver();
    void refresh();
  });
  window.addEventListener('member-admin-data-refreshed', () => {
    ensureQueueObserver();
    void refresh();
  });
  window.addEventListener('member-admin:booking-snapshot', () => {
    ensureQueueObserver();
    void refresh();
  });
  window.addEventListener('member-admin:booking-focus', () => {
    ensureQueueObserver();
    window.setTimeout(decorateCards, 0);
  });
})();
