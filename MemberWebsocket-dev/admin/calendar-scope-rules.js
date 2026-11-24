/* Shared, testable boundaries for the three administrator calendar surfaces. */
(function (root) {
  'use strict';

  function validIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return false;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
  }

  function isTicketCalendarEntry(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.sourceEventTicketId || item.source_event_ticket_id) return true;
    try {
      const url = new URL(String(item.linkUrl || ''), 'https://calendar.invalid/');
      return url.searchParams.get('source') === 'event-ticket-calendar'
        && Boolean(url.searchParams.get('eventTicketId'));
    } catch (_) { return false; }
  }

  function belongsToScope(scope, item) {
    if (!item || typeof item !== 'object') return false;
    if (scope === 'activity') return ['holiday', 'event'].includes(String(item.itemType || '')) && !isTicketCalendarEntry(item);
    if (scope === 'ticket') return Boolean(String(item.eventTicketId || '').trim());
    if (scope === 'booking') return Boolean(String(item.bookingId || '').trim());
    return false;
  }

  function occursOn(item, date) {
    const start = String(item && (item.startsOn || item.bookingDate) || '');
    const end = String(item && item.endsOn || start);
    return validIsoDate(date) && validIsoDate(start) && validIsoDate(end) && start <= date && date <= end;
  }

  const rules = Object.freeze({ validIsoDate, isTicketCalendarEntry, belongsToScope, occursOn });
  root.MemberAdminCalendarScopes = rules;
  if (typeof module !== 'undefined' && module.exports) module.exports = rules;
})(typeof window !== 'undefined' ? window : globalThis);
