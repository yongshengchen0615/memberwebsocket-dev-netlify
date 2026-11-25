/* Keep the member-facing cutoff aligned with the existing server business-date window.
 * This is only a UX gate; both modification APIs re-check the original booking.
 */
(function (root) {
  'use strict';
  const DEFAULT_MESSAGE = '此預約已超過線上可修改時間，請至現場洽詢修改預約。';

  function addDays(date, count) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
    const parsed = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime())) return '';
    parsed.setUTCDate(parsed.getUTCDate() + count);
    return parsed.toISOString().slice(0, 10);
  }

  function canModifyOnline(booking, settings, businessToday, nowMs) {
    if (!booking || !['pending', 'confirmed'].includes(booking.status)) return false;
    if (booking.cancellationRequestedAt && !booking.cancellationReviewedAt) return false;
    const day = String(booking.bookingDate || '');
    const minimumDays = Number(settings?.minAdvanceDays ?? 0);
    if (!Number.isInteger(minimumDays) || minimumDays < 0 || minimumDays > 365) return false;
    const earliestDay = addDays(businessToday, minimumDays);
    if (!earliestDay || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < earliestDay) return false;
    const startsAt = Date.parse(booking.startAt || (day + 'T' + String(booking.startTime || '') + ':00+08:00'));
    return Number.isFinite(startsAt) && Number.isFinite(nowMs) && startsAt > nowMs;
  }

  const api = Object.freeze({ DEFAULT_MESSAGE, canModifyOnline });
  root.BookingOnsiteEditPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
