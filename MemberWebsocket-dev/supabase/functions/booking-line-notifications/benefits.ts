import { isEligibleTierActivity } from "../_shared/activity-eligibility.ts";

const TIER_KEYS = ['general', 'silver', 'gold', 'platinum'] as const;

type Benefits = {
  pointTickets: string[];
  eventTickets: string[];
  tierActivities: string[];
  tierLabel: string;
};

function text(value: unknown, max = 240): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(normalized).slice(0, max).join('');
}

export function taipeiDate(): string {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).forEach((part) => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatDate(value: unknown): string {
  const date = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replaceAll('-', '/') : '';
}

function dateRange(startsOn: unknown, endsOn: unknown): string {
  const start = formatDate(startsOn);
  const end = formatDate(endsOn);
  if (start && end && start !== end) return `${start}–${end}`;
  return start || end;
}

function allowedTierKeys(value: unknown, emptyMeansAll = false): string[] {
  const keys = Array.isArray(value)
    ? value.map(String).filter((key) => (TIER_KEYS as readonly string[]).includes(key))
    : [];
  if (keys.length) return [...new Set(keys)];
  return emptyMeansAll ? [...TIER_KEYS] : [];
}

function line(parts: unknown[]): string {
  return parts.map((part) => text(part)).filter(Boolean).join('｜');
}

function usage(row: any): string {
  return text(row?.usage_method || row?.usage_instructions || '', 120);
}

export function isUsablePointCard(card: any, today: string): boolean {
  if (!card || card.status !== 'active') return false;
  return card.expiry_mode !== 'date'
    || !card.expires_on
    || String(card.expires_on) >= today;
}

export function isUsableEventClaim(claim: any, currentTier: string, today: string): boolean {
  if (!claim || claim.status !== 'claimed') return false;
  const event = claim.event_tickets || {};
  if (event.status !== 'active' || event.deleted_at) return false;
  if (event.starts_on && today < String(event.starts_on)) return false;
  if (event.ends_on && today > String(event.ends_on)) return false;
  return allowedTierKeys(event.allowed_tier_keys).includes(currentTier);
}

function ensureNoError(result: any): any {
  if (result?.error) throw new Error('BENEFIT_QUERY_FAILED');
  return result?.data;
}

export async function loadBookingConfirmationBenefits(db: any, job: any): Promise<Benefits> {
  const bookingId = text(job?.booking_id, 80);
  if (!bookingId) throw new Error('BOOKING_ID_REQUIRED');

  const booking = await db.from('bookings').select('member_id').eq('id', bookingId).maybeSingle();
  const bookingRow = ensureNoError(booking);
  if (!bookingRow?.member_id) throw new Error('BOOKING_MEMBER_NOT_FOUND');

  const memberId = String(bookingRow.member_id);
  const memberResult = await db.from('members')
    .select('id,line_user_id,status,membership_status,birthday')
    .eq('id', memberId)
    .maybeSingle();
  const member = ensureNoError(memberResult);
  if (!member) throw new Error('BOOKING_MEMBER_NOT_FOUND');

  // The outbox recipient is server-generated. Re-check the canonical binding before enrichment.
  if (text(member.line_user_id, 120) !== text(job?.recipient, 120)) {
    throw new Error('BOOKING_RECIPIENT_MISMATCH');
  }
  if (member.status !== 'active' || member.membership_status !== 'active') {
    return { pointTickets: [], eventTickets: [], tierActivities: [], tierLabel: '會員資格未啟用' };
  }

  const tierResult = await db.rpc('current_tier_key', { p_member_id: memberId });
  const currentTier = text(ensureNoError(tierResult) || 'general', 30) || 'general';
  const tierLabelResult = await db.from('membership_tier_settings')
    .select('tier_label')
    .eq('tier_key', currentTier)
    .maybeSingle();
  const tierLabelRow = ensureNoError(tierLabelResult);
  const tierLabel = text(tierLabelRow?.tier_label || '一般會員', 40);
  const today = taipeiDate();

  const cardsResult = await db.from('point_cards')
    .select('id,title,status,expiry_mode,expires_on')
    .eq('status', 'active')
    .order('sort_order', { ascending: true });
  const activeCards = (ensureNoError(cardsResult) || []).filter((card: any) =>
    isUsablePointCard(card, today)
  );
  const pointCardIds = activeCards.map((card: any) => card.id).filter(Boolean);

  if (pointCardIds.length) {
    ensureNoError(await db.rpc('issue_eligible_point_tickets_for_member', {
      p_member_id: memberId,
      p_point_card_ids: pointCardIds,
    }));
  }

  const pointTicketsResult = pointCardIds.length
    ? await db.from('point_tickets')
        .select('ticket_title,usage_method,usage_instructions,point_card_id,earned_at')
        .eq('member_id', memberId)
        .eq('status', 'available')
        .in('point_card_id', pointCardIds)
        .order('earned_at', { ascending: true })
    : { data: [], error: null };
  const pointTickets = ensureNoError(pointTicketsResult) || [];
  const cardById = new Map(activeCards.map((card: any) => [String(card.id), card]));
  const pointTicketLines = pointTickets.map((ticket: any) => {
    const card = cardById.get(String(ticket.point_card_id)) as any;
    const expiry = card?.expiry_mode === 'date' && card?.expires_on
      ? `有效至 ${formatDate(card.expires_on)}`
      : '';
    return line([ticket.ticket_title, expiry, usage(ticket)]);
  }).filter(Boolean);

  const eventClaimsResult = await db.from('event_ticket_claims')
    .select('ticket_title,usage_method,usage_instructions,status,event_ticket_id,event_tickets(*)')
    .eq('member_id', memberId)
    .eq('status', 'claimed')
    .order('claimed_at', { ascending: true });
  const eventClaims = ensureNoError(eventClaimsResult) || [];
  const eventTicketLines = eventClaims.flatMap((claim: any) => {
    const event = claim.event_tickets || {};
    if (!isUsableEventClaim(claim, currentTier, today)) return [];
    return [line([
      claim.ticket_title || event.title,
      dateRange(event.starts_on, event.ends_on),
      usage(claim),
    ])];
  }).filter(Boolean);

  const calendarResult = await db.from('calendar_items')
    .select('id,title,item_type,description,starts_on,ends_on,status,allowed_tier_keys,source_event_ticket_id,audience_type,audience_month')
    .eq('item_type', 'event')
    .in('status', ['active', 'targeted'])
    .order('starts_on', { ascending: true });
  const calendarItems = ensureNoError(calendarResult) || [];

  const sourceEventIds = [...new Set(
    calendarItems.map((item: any) => item.source_event_ticket_id).filter(Boolean).map(String)
  )];
  const sourceEventsResult = sourceEventIds.length
    ? await db.from('event_tickets')
        .select('id,status,starts_on,ends_on,quota,allowed_tier_keys,deleted_at')
        .in('id', sourceEventIds)
    : { data: [], error: null };
  const sourceEvents = ensureNoError(sourceEventsResult) || [];
  const sourceEventById = new Map<string, any>(sourceEvents.map((row: any) => [String(row.id), row]));

  const countsResult = sourceEventIds.length
    ? await db.rpc('event_ticket_claim_counts', { p_event_ids: sourceEventIds })
    : { data: [], error: null };
  const claimCounts = new Map<string, number>();
  for (const row of ensureNoError(countsResult) || []) {
    claimCounts.set(String(row.event_ticket_id), Number(row.claimed_count || 0));
  }

  const tierActivityLines = calendarItems.flatMap((item: any) => {
    if (!isEligibleTierActivity(item, currentTier, today, member.birthday, sourceEventById, claimCounts)) return [];

    return [line([item.title, dateRange(item.starts_on, item.ends_on), item.description])];
  }).filter(Boolean);

  return {
    pointTickets: pointTicketLines,
    eventTickets: eventTicketLines,
    tierActivities: tierActivityLines,
    tierLabel,
  };
}
