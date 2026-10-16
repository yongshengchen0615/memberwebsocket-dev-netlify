(() => {
  'use strict';

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const INLINE_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

  function formatDateWithWeekday(value) {
    const raw = String(value || '');
    const match = DATE_PATTERN.exec(raw);
    if (!match) return raw || '—';

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) return raw;

    return `${year}/${month}/${day}（星期${WEEKDAYS[date.getUTCDay()]}）`;
  }

  function formatInlineIsoDates(text) {
    return String(text || '').replace(INLINE_DATE_PATTERN, (full, year, month, day) => (
      formatDateWithWeekday(`${year}-${month}-${day}`)
    ));
  }

  function mount() {
    if (window.BookingSystem && typeof window.BookingSystem === 'object') {
      window.BookingSystem.formatDate = formatDateWithWeekday;
      window.BookingSystem.formatDateWithWeekday = formatDateWithWeekday;
    }

    const nativeConfirm = typeof window.confirm === 'function' ? window.confirm.bind(window) : null;
    if (nativeConfirm && !window.__bookingWeekdayConfirmPatched) {
      window.__bookingWeekdayConfirmPatched = true;
      window.confirm = (message) => nativeConfirm(formatInlineIsoDates(message));
    }
  }

  mount();
})();
