// Read-only monthly catalogue for the member-tier progress card.
// Never use this result as ticket ownership or redemption authorization.
export const MONTHLY_TIERS = Object.freeze([
  Object.freeze({ key: 'general', label: '一般會員' }),
  Object.freeze({ key: 'silver', label: '銀級會員' }),
  Object.freeze({ key: 'gold', label: '金級會員' }),
  Object.freeze({ key: 'platinum', label: '白金會員' }),
]);
const VALID_KEYS = new Set(MONTHLY_TIERS.map((tier) => tier.key));

export function currentTaipeiMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

export function monthlyTierBounds(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(month))) throw Error('INVALID_MONTH');
  const [year, number] = month.split('-').map(Number);
  return {
    start: `${month}-01`,
    end: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10),
  };
}

function overlapsMonth(item, start, end, kind) {
  const from = String(item.starts_on || '');
  // Calendar activities without an end date are single-day events. Tickets
  // without an end date instead retain their open-ended validity.
  const to = String(item.ends_on || (kind === 'activity' ? item.starts_on : '') || '');
  return (!from || from <= end) && (!to || to >= start);
}

function tierKeys(row, allWhenEmpty) {
  const keys = Array.isArray(row.allowed_tier_keys)
    ? row.allowed_tier_keys.map(String).filter((key) => VALID_KEYS.has(key))
    : [];
  return keys.length ? [...new Set(keys)] : allWhenEmpty ? MONTHLY_TIERS.map((tier) => tier.key) : [];
}

function isCalendarTicketMirror(row) {
  if (row.source_event_ticket_id) return true;
  try {
    const url = new URL(String(row.link_url || ''), 'https://member-calendar.invalid/');
    return url.searchParams.get('source') === 'event-ticket-calendar'
      && Boolean(url.searchParams.get('eventTicketId'));
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   month: string,
 *   tickets?: Record<string, unknown>[],
 *   activities?: Record<string, unknown>[],
 *   showTickets?: boolean,
 *   showActivities?: boolean
 * }} options
 */
export function buildMonthlyTierOverview({
  month, tickets = [], activities = [], showTickets = true, showActivities = true,
}) {
  const { start, end } = monthlyTierBounds(month);
  const tiers = MONTHLY_TIERS.map((tier) => ({ ...tier, offers: [] }));
  const byKey = new Map(tiers.map((tier) => [tier.key, tier]));

  function include(row, kind, defaultAll) {
    const title = String(row.title || '').trim().slice(0, 160);
    if (!title || !overlapsMonth(row, start, end, kind)) return;
    const offer = {
      kind,
      title,
      startsOn: String(row.starts_on || ''),
      endsOn: String(row.ends_on || (kind === 'activity' ? row.starts_on : '') || ''),
    };
    for (const key of tierKeys(row, defaultAll)) byKey.get(key).offers.push({ ...offer });
  }

  if (showTickets && Array.isArray(tickets)) {
    for (const row of tickets) {
      if (!row || row.status !== 'active' || row.deleted_at
        || !['coupon', 'lottery'].includes(String(row.ticket_type))
        || row.referral_source_event_ticket_id || row.fixed_ticket_template_id) continue;
      include(row, 'ticket', false);
    }
  }
  if (showActivities && Array.isArray(activities)) {
    for (const row of activities) {
      if (!row || row.item_type !== 'event' || row.status !== 'active'
        || !['', 'all'].includes(String(row.audience_type || ''))
        || isCalendarTicketMirror(row)) continue;
      include(row, 'activity', true);
    }
  }
  for (const tier of tiers) {
    tier.offers.sort((a, b) => a.startsOn.localeCompare(b.startsOn)
      || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, 'zh-Hant'));
  }
  return { month, tiers };
}
