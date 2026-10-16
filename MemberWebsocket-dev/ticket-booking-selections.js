(() => {
  'use strict';
  let settings, bookings = [], editor = null, busy = false, sequence = 0, dirty = false, attempt = null, draft = null, stale = false;
  const $ = id => document.getElementById(id);
  const node = (tag, value, className = '') => { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; };
  const newId = () => 'BSEL-' + crypto.randomUUID();
  const times = b => {
    // A ticket is reserved against the whole booking. Participant service slots can end
    // earlier (e.g. before the 10-minute in-store service included in the booking).
    // Fall back to participant slots only for legacy records missing the booking range.
    const slots = b.startTime && b.endTime
      ? [b]
      : Array.isArray(b.serviceSlots) && b.serviceSlots.length ? b.serviceSlots : [b];
    return slots.map((s, i) => `${slots.length > 1 ? `時段 ${i + 1} · ` : ''}${String(s.startAt || s.bookingDate || b.bookingDate).slice(0, 10)} ${s.startTime}–${String(s.endAt || '').slice(0, 10) !== String(s.startAt || '').slice(0, 10) ? '翌日 ' : ''}${s.endTime}`).join('；');
  };
  const label = context => `已選於 ${times(context)}${context.status === 'redeemed' ? ' · 已核銷' : ''}`;
  function request(operation, body) {
    return window.MemberSystem.request(settings.config, settings.surface, settings.idToken,
      `user.${settings.surface === 'points' ? 'pointcard' : 'event'}.booking-selections.${operation}`, body);
  }
  function message(value, error = false) {
    const p = $('bookingSelectionMessage'); if (!p) return;
    p.textContent = value; p.classList.toggle('is-error', error);
  }
  function install() {
    // The event page uses per-ticket reservation disclosures, not the standalone editor.
    // Keep the shared context for event ticket cancellation and refresh callbacks.
    if (settings.surface !== 'points') return;
    // Keep the shared cancellation context without showing the standalone booking editor.
    if (settings.showStandaloneEditor === false) {
      $('bookingSelectionPanel')?.remove();
      return;
    }
    if ($('bookingSelectionPanel')) return;
    const host = $(settings.surface === 'points' ? 'pointsView' : 'eventView'); if (!host) return;
    const panel = node('section', '', 'booking-selection-panel'); panel.id = 'bookingSelectionPanel';
    panel.setAttribute('aria-label', '預約票券選用');
    panel.append(node('h2', '預約票券選用'), node('p', '預選票券不扣點。服務結束後、管理員完成結算前仍可增減；已核銷票券不能修改。'));
    const status = node('p', ''); status.id = 'bookingSelectionMessage'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const list = node('div', ''); list.id = 'bookingSelectionList';
    const form = node('form', ''); form.id = 'bookingSelectionEditor'; form.hidden = true;
    form.addEventListener('submit', e => { e.preventDefault(); void save(); });
    panel.append(status, list, form); host.append(panel);
  }
  function render(nextBookings, config) {
    settings = config; bookings = Array.isArray(nextBookings) ? nextBookings : []; install();
    if (!$('bookingSelectionList')) return;
    const list = $('bookingSelectionList'); list.replaceChildren();
    if (!bookings.length) list.append(node('p', '目前沒有尚未結算的預約。'));
    for (const booking of bookings) {
      const row = node('article', '', 'booking-selection-row');
      const copy = node('div', ''); copy.append(node('strong', times(booking)),
        node('small', `${booking.status === 'confirmed' ? '已確認' : '待確認'} · 預約 ${booking.bookingId.slice(0, 8)} · ${booking.selections.filter(s => s.status === 'pending').length} 張預選票券`));
      const open = node('button', booking.editable ? '調整票券' : booking.disabledReason, 'button button-outline');
      open.type = 'button'; open.disabled = !booking.editable || busy;
      open.addEventListener('click', () => void load(booking.bookingId)); row.append(copy, open); list.append(row);
    }
    if (editor && !busy) {
      const current = bookings.find(b => b.bookingId === editor.booking.bookingId);
      if (!current || !current.editable || current.updatedAt !== editor.booking.updatedAt) {
        stale = true;
        $('bookingSelectionSave').disabled = true;
        message('預約或票券已更新，請按「重新載入」取得最新狀態再調整。', true);
      }
    }
  }
  async function load(bookingId) {
    if (busy) return;
    if (dirty && !window.confirm('重新載入會放棄尚未儲存的票券選取，確定繼續？')) return;
    const current = ++sequence; busy = true; message('正在載入可選票券…');
    try {
      const data = await request('detail', { bookingId }); if (current !== sequence) return;
      editor = data; draft = null; dirty = false; attempt = null; stale = false;
      bookings = bookings.map(b => b.bookingId === bookingId ? data.booking : b);
      drawEditor(); message('');
    } catch (e) { message(e.message || '票券載入失敗，請重試。', true); }
    finally { busy = false; if (editor) validate(); }
  }
  function drawEditor() {
    const form = $('bookingSelectionEditor'); form.hidden = false; form.replaceChildren();
    form.append(node('h3', times(editor.booking)));
    const selected = draft || editor.booking.selections.filter(s => s.status === 'pending' && ['points', 'event'].includes(s.kind));
    const items = (editor.options.items || []).filter(o => ['points', 'event'].includes(o.kind) && o.selectionId);
    for (const s of selected) if (!items.some(o => o.kind === s.kind && o.selectionId === s.id))
      items.push({kind:s.kind,selectionId:s.id,title:s.title,selectable:false,disabledReason:'票券已失效；可取消預選'});
    for (const s of editor.booking.selections.filter(s => ['redeemed', 'applied'].includes(s.status)))
      form.append(node('p', `${s.title} · 已核銷，不能修改`));
    for (const item of items) {
      const isChosen = selected.some(s => s.kind === item.kind && s.id === item.selectionId);
      const wrap = node('label', '', 'booking-selection-option');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = isChosen;
      check.dataset.kind = item.kind; check.dataset.ref = item.selectionId;
      check.disabled = !editor.booking.editable || (!isChosen && !item.selectable);
      check.addEventListener('change', () => { dirty = true; attempt = null;
        if (!item.selectable && !check.checked) check.disabled = true; draft = chosen(); validate(); });
      const copy = node('span', ''); copy.append(node('strong', `${item.kind === 'points' ? '集點卡' : '活動'} · ${item.title}`),
        node('small', item.disabledReason || item.conditionLabel || ''));
      wrap.append(check, copy); form.append(wrap);
    }
    if (!items.length) form.append(node('p', '目前沒有可預選的票券。'));
    const controls = node('div', '', 'booking-selection-controls');
    const submit = node('button', '儲存預選票券', 'button button-dark'); submit.id = 'bookingSelectionSave'; submit.type = 'submit';
    const reload = node('button', '重新載入', 'button button-outline'); reload.type = 'button';
    reload.addEventListener('click', () => void load(editor.booking.bookingId));
    const close = node('button', '關閉', 'button button-outline'); close.type = 'button';
    close.addEventListener('click', () => { if (busy) return; if (dirty && !window.confirm('放棄尚未儲存的選取？')) return; editor = null; dirty = false; form.hidden = true; });
    controls.append(submit, reload, close); form.append(controls); validate();
  }
  function chosen() {
    return [...$('bookingSelectionEditor').querySelectorAll('input:checked')].map(c => ({kind:c.dataset.kind,id:c.dataset.ref}));
  }
  function validate() {
    if (!editor) return false;
    const selections = chosen(); let reason = '';
    for (const kind of ['points', 'event']) {
      const limit = Number(editor.options[kind === 'points' ? 'pointTicketMaxPerRedemption' : 'eventTicketMaxPerDay'] ?? 1);
      const used = editor.booking.selections.filter(s => s.kind === kind && s.status === 'redeemed').length;
      if (limit > 0 && selections.filter(s => s.kind === kind).length + used > limit) reason = '已超過票券使用張數上限。';
    }
    const budgets = new Map();
    for (const s of selections.filter(s => s.kind === 'points')) {
      const item = editor.options.items.find(o => o.kind === s.kind && o.selectionId === s.id);
      if (!item) { reason = '請取消已失效的預選票券。'; continue; }
      const budget = budgets.get(item.cardId) || { balance:Number(item.pointBalance || 0),spent:0 };
      budget.spent += Number(item.pointCost || 0); budgets.set(item.cardId, budget);
    }
    if ([...budgets.values()].some(b => b.spent > b.balance)) reason = '可用點數不足，請減少預選票券。';
    if (stale) reason = '預約或票券已更新，請按「重新載入」取得最新狀態再調整。';
    $('bookingSelectionSave').disabled = busy || !editor.booking.editable || Boolean(reason);
    if (reason) message(reason, true); else if (dirty) message('尚未儲存；儲存後才會同步到管理端。');
    return !reason;
  }
  async function save() {
    if (!editor || busy || !validate()) return;
    const benefits = chosen(); draft = benefits;
    let saveError = '';
    attempt ||= {bookingId:editor.booking.bookingId,expectedUpdatedAt:editor.booking.updatedAt,benefits,requestId:newId()};
    busy = true; $('bookingSelectionSave').disabled = true; message('正在儲存…');
    $('bookingSelectionEditor').querySelectorAll('input,button').forEach(n => n.disabled = true);
    try {
      await request('update', attempt); editor = null; dirty = false; attempt = null; draft = null;
      $('bookingSelectionEditor').hidden = true;
      await settings.refresh(); message('預選票券已儲存並同步。點數會在最終結算時扣除。');
    } catch (e) {
      saveError = e.message || '無法確認儲存結果；重新送出會沿用同一識別碼，請勿另開重複操作。';
      if (e.code === 'BOOKING_CONFLICT' || e.code === 'BOOKING_NOT_EDITABLE') stale = true;
      if (e.code) attempt = null;
    } finally {
      busy = false;
      render(bookings, settings);
      if (editor) { drawEditor(); if (!bookings.some(b => b.bookingId===editor.booking.bookingId && b.updatedAt===editor.booking.updatedAt)) $('bookingSelectionSave').disabled=true; }
      if (saveError && !stale) message(saveError, true);
    }
  }
  // Release only one pending point ticket. The existing transactional member RPC
  // checks booking ownership, status and version, and preserves unrelated selections.
  async function cancelTicket(bookingId, kind, ticketId) {
    if (!['points', 'event'].includes(kind) || settings?.surface !== kind) throw new Error('請從對應的票券頁面操作。');
    const id = String(bookingId || '');
    const ref = String(ticketId || '');
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id) || !ref || ref.length > 120)
      throw new Error('預約或票券識別不正確，請重新整理。');
    if (busy) return false;
    if (dirty) throw new Error('請先儲存或關閉目前的票券調整表單。');
    if (!window.confirm(`確定取消這張${kind === 'points' ? '集點卡' : '活動'}票券的預約使用？\n預約本身與其他票券均不受影響。`)) return false;

    busy = true;
    message('正在取消票券預約使用…');
    let updated = false;
    try {
      // Always fetch the current booking and its version, not a stale ticket-card snapshot.
      const detail = await request('detail', { bookingId: id });
      const booking = detail?.booking;
      if (!booking?.editable) throw new Error(booking?.disabledReason || '此預約已不能調整票券。');
      const selections = Array.isArray(booking.selections) ? booking.selections : [];
      const selected = selections.some(s => s.kind === kind && s.id === ref && s.status === 'pending');
      if (selected) {
        const benefits = selections.filter(s =>
          s.status === 'pending' && ['points', 'event'].includes(s.kind)
          && !(s.kind === kind && s.id === ref)
        ).map(s => ({ kind: s.kind, id: s.id }));
        await request('update', {
          bookingId: id, expectedUpdatedAt: booking.updatedAt,
          benefits, requestId: newId()
        });
        updated = true;
      }
      if (editor?.booking?.bookingId === id) {
        editor = null; draft = null; dirty = false; attempt = null; stale = false;
        const form = $('bookingSelectionEditor'); if (form) form.hidden = true;
      }
      await settings.refresh();
      message(selected ? '已取消這張票券的預約使用；原預約和其他票券保持不變。' : '這張票券已不在預約選用中，資料已同步。');
      return true;
    } catch (error) {
      const reason = updated
        ? '票券已取消，但頁面資料同步失敗，請重新整理確認。'
        : String(error?.message || '取消預約使用失敗，請重新載入後重試。');
      message(reason, true);
      throw new Error(reason);
    } finally {
      busy = false;
      if (settings && $('bookingSelectionList')) render(bookings, settings);
    }
  }


  function cancelPointTicket(bookingId, ticketId) {
    return cancelTicket(bookingId, 'points', ticketId);
  }

  // Native details/summary lets users reveal every independent booking intent.
  function createTicketReservationDisclosure({
    title = '票券', bookingSelections = [], pendingSnapshots = [],
    expanded = false, onToggle, onCancelBooking, onCancelSnapshot
  } = {}) {
    const contexts = (Array.isArray(bookingSelections) ? bookingSelections : [])
      .filter(c => c && c.bookingId && ['pending', 'redeemed', 'applied'].includes(c.status));
    const seen = new Set();
    const snapshots = (Array.isArray(pendingSnapshots) ? pendingSnapshots : []).filter(s => {
      const id = String(s?.receiptId || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!contexts.length && !snapshots.length) return null;
    const details = node('details', '', 'ticket-reservation-disclosure');
    details.open = Boolean(expanded);
    const summary = node('summary', `預約使用明細（${contexts.length + snapshots.length} 筆）`, 'ticket-reservation-summary');
    summary.setAttribute('aria-label', `展開或收合「${title}」的預約票券使用明細`);
    details.append(summary);
    const list = node('div', '', 'ticket-reservation-list');
    function addCancel(row, caption, name, onClick) {
      if (typeof onClick !== 'function') return;
      const button = node('button', caption, 'ticket-reservation-cancel');
      button.type = 'button';
      button.setAttribute('aria-label', name);
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await onClick(); } finally { button.disabled = false; }
      });
      row.append(button);
    }
    for (const context of contexts) {
      const row = node('div', '', 'ticket-reservation-row');
      row.append(node('strong', '一般預約', 'ticket-reservation-kind'));
      row.append(node('span', label(context), 'ticket-reservation-detail'));
      if (context.status === 'pending' && context.editable) {
        addCancel(row, '取消此一般預約票券', `取消「${title}」於 ${times(context)} 的一般預約票券`,
          () => onCancelBooking?.(context));
      } else {
        row.append(node('small', context.status === 'pending'
          ? context.disabledReason || '目前不能調整此預約'
          : '此票券已核銷，無法取消', 'ticket-reservation-reason'));
      }
      list.append(row);
    }
    for (const snapshot of snapshots) {
      const row = node('div', '', 'ticket-reservation-row');
      row.append(node('strong', '快照預約・待審核', 'ticket-reservation-kind'));
      const created = String(snapshot.createdAt || '');
      const parsed = created ? new Date(created) : null;
      const dateLabel = parsed && !Number.isNaN(parsed.getTime())
        ? new Intl.DateTimeFormat('zh-Hant-TW', {
          timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(parsed)
        : '';
      row.append(node('span', `${dateLabel ? `提交時間 ${dateLabel} · ` : ''}快照編號 ${String(snapshot.receiptId)}`, 'ticket-reservation-detail'));
      addCancel(row, '取消此快照票券', `取消「${title}」於快照 ${snapshot.receiptId} 的票券`,
        () => onCancelSnapshot?.(snapshot));
      list.append(row);
    }
    details.append(list);
    if (typeof onToggle === 'function') details.addEventListener('toggle', () => onToggle(details.open));
    return details;
  }

  window.TicketBookingSelections = Object.freeze({ render, label, cancelPointTicket, cancelTicket, createTicketReservationDisclosure });
})();
