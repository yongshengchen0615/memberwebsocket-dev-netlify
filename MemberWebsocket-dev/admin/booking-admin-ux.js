(() => {
  'use strict';

  // Track user-initiated booking writes only. Background polling, badge reads
  // and realtime invalidations must not cover the admin screen with a spinner.
  const bookingWrites = new Set([
    'admin.booking.type.create', 'admin.booking.type.update', 'admin.booking.type.delete',
    'admin.booking.service.save', 'admin.booking.service.delete', 'admin.booking.services.batch',
    'admin.booking.settings.save', 'admin.booking.messages.save',
    'admin.booking.phone.create', 'admin.booking.items.update',
    'admin.booking.participants.items.update', 'admin.booking.participants.technicians.update',
    'admin.booking.benefits.update', 'admin.booking.status.update',
    'admin.booking.reject-walkin', 'admin.booking.status.complete',
    'admin.booking.completed.correct', 'admin.booking.receipt.register',
    'admin.booking.receipt.dismiss', 'admin.booking.resources.settings.save',
    'admin.booking.resources.technician.save', 'admin.booking.price.publish',
    'admin.booking.price.reschedule', 'admin.booking.price.cancel',
    'admin.booking.risk.save', 'admin.booking.risk.revoke', 'admin.booking.risk.release',
  ]);
  // Explicit allowlist of foreground writes, never background polling or reads.
  const administrativeWrites = new Set([
    'admin.member-tiers.save','admin.member.force-logout','admin.member.remove',
    'admin.pointcards.reorder','admin.settings.copy','admin.pointcards.save',
    'admin.pointcards.archive','admin.pointcards.delete','admin.tickets.save',
    'admin.tickets.delete','admin.event-tickets.save','admin.event-tickets.delete',
    'admin.calendar-items.batch','admin.calendar-items.save','admin.calendar-items.delete',
    'admin.member.update','admin.grant-message-presets.save',
    'admin.service-grants.add','admin.member-grants.add',
    'admin.terms.draft.save','admin.terms.activate',
    'admin.fixed-tickets.save','admin.fixed-tickets.run',
    'admin.fixed-tickets.delete','admin.settings.save',
  ]);
  const platformWrites = new Set([
    'platform.title.save','platform.line.save',
    'platform.notifications.save','platform.notifications.test',
    'platform.frontdesk.settings.save','platform.frontdesk.staff.approve',
    'platform.frontdesk.staff.reject','platform.frontdesk.staff.delete',
    'platform.frontdesk.rejection-reasons.save',
  ]);
  const directActions = new Set([
    '確認預約', '取消預約', '取消登記預約',
    'disable-technician', 'restore-technician',
  ]);
  const formLabels = {
    bookingAdminSettingsForm: '儲存預約與票券共用設定',
    bookingAdminMessagesForm: '儲存所有預約通知訊息',
    bookingAdminPartySizeForm: '儲存預約人數與主要技師設定',
    bookingAdminTechnicianForm: '儲存技師資料',
    accessibleAdminForm: '審核收據、登記服務並完成點數與票券結算',
  };
  const originalFetch = window.fetch;
  let pending = 0;
  const originalInert = new Map();

  function overlay() {
    let element = document.getElementById('adminBookingPendingOverlay');
    if (element) return element;
    element = document.createElement('div');
    element.id = 'adminBookingPendingOverlay';
    element.className = 'admin-booking-pending-overlay';
    element.hidden = true;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
    element.textContent = '正在處理預約操作… 請勿重複點擊，系統正在等待後端回覆。';
    document.body.append(element);
    return element;
  }

  function begin() {
    pending += 1;
    const screen = overlay();
    screen.hidden = false;
    for (const node of document.body.children || []) {
      if (node === screen || originalInert.has(node)) continue;
      originalInert.set(node,Boolean(node.inert));
      node.inert = true;
    }
    document.body.setAttribute('data-admin-booking-pending', 'true');
    return endOnce();
  }

  function endOnce() {
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      pending = Math.max(0, pending - 1);
      if (pending === 0) {
        overlay().hidden = true;
        for (const [node,wasInert] of originalInert) node.inert = wasInert;
        originalInert.clear();
        document.body.removeAttribute('data-admin-booking-pending');
      }
    };
  }

  function trackedRequest(input, options) {
    if (!options || typeof options.body !== 'string') return false;
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!url.includes('/functions/v1/')) return false;
    try {
      const body = JSON.parse(options.body);
      const action = String(body?.action || '');
      if (body?.clientType === 'admin' && (
        bookingWrites.has(action) || administrativeWrites.has(action)
        || ((action === 'admin.approve' || action === 'admin.reject')
          && url.includes('/booking-cancellation-api'))
      )) return true;
      if (url.includes('/platform-api') && platformWrites.has(action)) return true;
      if (url.includes('/fixed-ticket-automation') && administrativeWrites.has(action)) return true;
      return url.includes('/event-ticket-extension-api')
        && body?.operation === 'admin.settings.save';
    } catch {
      return false;
    }
  }

  window.fetch = function bookingFeedbackFetch(input, options) {
    if (!trackedRequest(input, options)) return originalFetch.call(this, input, options);
    const finish = begin();
    try {
      return Promise.resolve(originalFetch.call(this, input, options)).finally(finish);
    } catch (error) {
      finish();
      throw error;
    }
  };

  function cancel(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function formDescription(form) {
    if (form.classList?.contains('booking-risk-policy-form')) return '';
    if (form.querySelector?.('[data-correction-fields]')) return '';
    if (formLabels[form.id]) return formLabels[form.id];
    if (form.closest?.('#bookingAdminCrudModal')) {
      const heading = document.getElementById('bookingAdminCrudModalTitle')?.textContent || '預約變更';
      return String(heading).trim().slice(0, 100);
    }
    if (form.closest?.('.booking-price-dialog')) return '發佈或調整預約項目價格';
    return '';
  }

  document.addEventListener('submit', (event) => {
    if (pending > 0) return cancel(event);
    const form = event.target;
    if (!form?.matches?.('form')) return;
    const operation = formDescription(form);
    if (!operation || form.getAttribute('aria-busy') === 'true') return;
    const submit = form.querySelector?.('[type="submit"]');
    if (submit?.disabled) return;
    if (!window.confirm(`請再次確認：${operation}？\n\n確認後才會傳送至後端，並以後端實際回應為準。`)) cancel(event);
  }, true);

  document.addEventListener('click', (event) => {
    if (pending > 0) return cancel(event);
    const button = event.target?.closest?.('[data-booking-admin-action]');
    if (!button || button.disabled) return;
    const action = String(button.dataset.bookingAdminAction || '');
    if (!directActions.has(action)) return;
    const card = button.closest?.('[data-booking-id]');
    const details = card?.dataset || {};
    const display = action === 'disable-technician' ? '停用技師'
      : action === 'restore-technician' ? '恢復技師公開' : action;
    const bookingSummary = card
      ? `\n預約人：${String(details.bookingMemberName || '—').slice(0, 80)}\n日期：${details.bookingDate || '—'}\n時間：${details.bookingStartTime || '—'}–${details.bookingEndTime || '—'}`
      : '';
    if (!window.confirm(`請再次確認：${display}？${bookingSummary}\n\n確認後才會送出，無法以再次點擊代替檢查結果。`)) cancel(event);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (pending > 0 && event.target !== overlay()) cancel(event);
  }, true);

  // Explicit pending scopes keep the indicator visible while an operation
  // performs an authoritative follow-up refresh after the first API response.
  window.AdminBookingUX = Object.freeze({ begin });
})();
