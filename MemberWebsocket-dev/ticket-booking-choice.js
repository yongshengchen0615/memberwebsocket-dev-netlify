(() => {
  'use strict';
  const fields = new WeakMap();
  function common(tickets) {
    if (!tickets.length) return [];
    const lists = tickets.map(ticket => Array.isArray(ticket.eligibleBookings) ? ticket.eligibleBookings : []);
    return lists[0].filter(booking => lists.every(list => list.some(item => item.bookingId === booking.bookingId)));
  }
  function mount(container, bookings, onChange = () => {}) {
    if (!container) return;
    const previous = fields.get(container)?.value || '';
    const label = document.createElement('label');
    label.className = 'ticket-booking-choice';
    const title = document.createElement('strong'); title.textContent = '本次使用的預約';
    const select = document.createElement('select');
    select.setAttribute('aria-label', '本次使用的預約');
    const placeholder = document.createElement('option'); placeholder.value = '';
    placeholder.textContent = bookings.length ? '請選擇已確認的預約' : '目前沒有符合條件的已確認預約';
    select.append(placeholder);
    for (const booking of bookings) {
      const option = document.createElement('option'); option.value = booking.bookingId;
      option.textContent = booking.bookingId === 'no-booking' ? booking.title : `${booking.bookingDate} ${booking.startTime} · ${booking.title || '預約服務'}`;
      select.append(option);
    }
    select.value = bookings.some(booking => booking.bookingId === previous) ? previous : bookings.length === 1 ? bookings[0].bookingId : '';
    const hint = document.createElement('small');
    hint.textContent = bookings.some(booking => booking.bookingId === 'no-booking')
      ? '目前允許不綁定預約；效期、點數及定位要求仍會於使用時驗證。'
      : '需為本人、管理員已確認且尚未完成的預約；票券也須符合該筆預約的服務項目。';
    label.append(title, select, hint); container.replaceChildren(label); fields.set(container, select);
    select.addEventListener('change', onChange);
  }
  function selected(container) { return fields.get(container)?.value || ''; }
  function lock(container, value) { const select = fields.get(container); if (select) select.disabled = value; }
  window.TicketBookingChoice = Object.freeze({common, mount, selected, lock});
})();
