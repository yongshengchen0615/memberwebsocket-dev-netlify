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
    const link = String(item.linkUrl || '');
    // Match the server-generated query keys exactly; do not confuse arbitrary
    // activities mentioning tickets in their names with synchronized entries.
    return /(?:[?&])source=event-ticket-calendar(?:[&#]|$)/.test(link)
      && /(?:[?&])eventTicketId=[^&#]+/.test(link);
  }

  function belongsToScope(scope, item) {
    if (!item || typeof item !== 'object') return false;
    if (scope === 'activity') return String(item.itemType || '') === 'event' && !isTicketCalendarEntry(item);
    if (scope === 'holiday') return String(item.itemType || '') === 'holiday';
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
