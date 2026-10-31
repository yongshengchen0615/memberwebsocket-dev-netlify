import type { SupabaseClient } from './business-runtime.ts';

type JsonRow = Record<string, any>;

export type CurrentPointOffer = {
  rewardId: string;
  ticketId?: string;
  requiresLocation?: boolean;
  pointCardId: string;
  cardTitle: string;
  styleKey: string;
  ticketTemplateId: string;
  ticketTitle: string;
  thresholdStamps: number;
  requiredServiceIds: string[];
  requiredServiceMatchMode: 'any' | 'all';
  requiredServiceGroups?: string[][];
  sortOrder: number;
};

export type AvailablePointTicketRef = {
  ticketId: string;
  requiresLocation: boolean;
  rewardId: string;
  pointCardId: string;
  ticketTemplateId: string;
  thresholdStamps: number;
};

export type CurrentEventOffer = {
  eventId: string;
  title: string;
  claimed: boolean;
  claimId?: string;
  requiresLocation?: boolean;
  requiredServiceIds: string[];
  requiredServiceMatchMode: 'any' | 'all';
  requiredServiceGroups?: string[][];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function taipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function relationActive(card: JsonRow | undefined, template: JsonRow | undefined, today: string): boolean {
  if (!card || !template) return false;
  if (text(card.status) !== "active" || text(template.status) !== "active") return false;
  if (text(card.expiry_mode) === "unlimited") return true;
  const expiresOn = text(card.expires_on);
  return !expiresOn || expiresOn >= today;
}

export function selectLatestPointOffers(
  rewards: JsonRow[],
  cards: JsonRow[],
  templates: JsonRow[],
  availableTickets: JsonRow[],
  today = "9999-12-31",
  includeEveryTicket = false,
): CurrentPointOffer[] {
  const cardById = new Map(cards.map((row) => [text(row.id), row]));
  const templateById = new Map(templates.map((row) => [text(row.id), row]));
  const tickets: AvailablePointTicketRef[] = availableTickets.map((row) => ({
    ticketId: text(row.ticket_id),
    requiresLocation: row.requires_location === true,
    rewardId: text(row.reward_id),
    pointCardId: text(row.point_card_id),
    ticketTemplateId: text(row.ticket_template_id),
    thresholdStamps: number(row.threshold_stamps),
  }));

  const offers: CurrentPointOffer[] = [];
  for (const reward of rewards) {
    const rewardId = text(reward.id);
    const pointCardId = text(reward.point_card_id);
    const ticketTemplateId = text(reward.ticket_template_id);
    const thresholdStamps = number(reward.threshold_stamps);
    const requiredServiceIds = Array.isArray(reward.required_service_ids)
      ? reward.required_service_ids.map(text).filter(Boolean)
      : [];
    const requiredServiceMatchMode = text(reward.required_service_match_mode) === "all" ? "all" : "any";
    const requiredServiceGroups = Array.isArray(reward.required_service_groups) ? reward.required_service_groups : [];
    const card = cardById.get(pointCardId);
    const template = templateById.get(ticketTemplateId);
    if (!rewardId || !pointCardId || !ticketTemplateId || thresholdStamps <= 0) continue;
    if (!relationActive(card, template, today)) continue;

    const matchesOffer = (ticket: AvailablePointTicketRef) =>
      ticket.pointCardId === pointCardId && (
        ticket.rewardId === rewardId ||
        (ticket.ticketTemplateId === ticketTemplateId && ticket.thresholdStamps === thresholdStamps)
      );
    // Notifications need one summary per reward; booking needs one selectable
    // entry per issued ticket (including repeated instances of one reward).
    const matchingTickets = tickets.filter(matchesOffer).sort((a, b) =>
      Number(a.requiresLocation) - Number(b.requiresLocation) || a.ticketId.localeCompare(b.ticketId)
    );
    for (const availableTicket of (includeEveryTicket ? matchingTickets : matchingTickets.slice(0, 1))) {
    const offer: CurrentPointOffer = {
      rewardId,
      pointCardId,
      cardTitle: text(card?.title) || "集點卡",
      styleKey: text(card?.style_key) || "citrus",
      ticketTemplateId,
      ticketTitle: text(template?.title) || "可用優惠",
      thresholdStamps,
      requiredServiceIds,
       requiredServiceMatchMode,
       requiredServiceGroups,
       sortOrder: number(card?.sort_order),
    };
    if (availableTicket.ticketId) offer.ticketId = availableTicket.ticketId;
    offer.requiresLocation = availableTicket.requiresLocation;
    offers.push(offer);
    }
  }

  return offers.sort((left, right) =>
    left.sortOrder - right.sortOrder ||
    left.thresholdStamps - right.thresholdStamps ||
    left.ticketTitle.localeCompare(right.ticketTitle, "zh-Hant")
  );
}

export function selectLatestEventOffers(
  events: JsonRow[],
  claims: JsonRow[],
  memberId: string,
  counts?: JsonRow[],
): CurrentEventOffer[] {
  const claimCounts = new Map<string, number>(
    (counts || []).map((row) => [text(row.event_ticket_id), number(row.claimed_count)]),
  );
  const memberAvailableClaims = new Map<string, string>();
  const memberUnavailableClaims = new Set<string>();

  for (const claim of claims) {
    const eventId = text(claim.event_ticket_id);
    const status = text(claim.status);
    if (!eventId) continue;

    // Inventory counts every issued claim, including used/cancelled claims, just like the DB.
    if (!counts) claimCounts.set(eventId, (claimCounts.get(eventId) || 0) + 1);
    if (text(claim.member_id) !== memberId) continue;

    if (status === "claimed" || status === "available") memberAvailableClaims.set(eventId, text(claim.claim_id));
    else memberUnavailableClaims.add(eventId);
  }

  const offers: CurrentEventOffer[] = [];
  for (const row of events) {
    const eventId = text(row.id);
    if (!eventId || memberUnavailableClaims.has(eventId)) continue;

    const claimed = memberAvailableClaims.has(eventId);
    if (!claimed && (row.fixed_ticket_template_id || ["referral","membership_join"].includes(text(row.ticket_type)))) continue;
    const quota = number(row.quota);
    const hasQuota = quota === 0 || (claimCounts.get(eventId) || 0) < quota;
    if (!claimed && !hasQuota) continue;

    const offer: CurrentEventOffer = {
      eventId,
      title: text(row.title) || "活動票券",
      claimed,
      requiredServiceIds: Array.isArray(row.required_service_ids)
        ? row.required_service_ids.map(text).filter(Boolean)
        : [],
      requiredServiceMatchMode: text(row.required_service_match_mode) === "all" ? "all" : "any",
      ...(Array.isArray(row.required_service_groups) && row.required_service_groups.length ? { requiredServiceGroups: row.required_service_groups } : {}),
    };
    const claimId = claimed ? (memberAvailableClaims.get(eventId) || "") : "";
    if (claimId) offer.claimId = claimId;
    if (Boolean(row.requires_location)) offer.requiresLocation = true;
    offers.push(offer);
  }

  return offers;
}

export async function loadLatestPointOffers(
  supabase: SupabaseClient,
  memberId: string,
  strict: boolean,
  includeEveryTicket = false,
): Promise<Array<CurrentPointOffer & { cardId: string; expiresOn: string }>> {
  const ticketsResult = await supabase
    .from("point_tickets")
    .select("ticket_id,reward_id,point_card_id,ticket_template_id,threshold_stamps,requires_location")
    .eq("member_id", memberId)
    .eq("status", "available")
    .limit(200);
  if (ticketsResult.error) {
    if (strict) throw ticketsResult.error;
    return [];
  }
  const tickets = ticketsResult.data || [];
  if (!tickets.length) return [];

  const cardIds = [...new Set(tickets.map((row: any) => text(row.point_card_id)).filter(Boolean))];
  if (!cardIds.length) return [];

  const rewardsResult = await supabase
    .from("point_card_rewards")
    .select("id,point_card_id,threshold_stamps,ticket_template_id,required_service_ids,required_service_match_mode,required_service_groups")
    .in("point_card_id", cardIds);
  if (rewardsResult.error) {
    if (strict) throw rewardsResult.error;
    return [];
  }
  const rewards = rewardsResult.data || [];
  if (!rewards.length) return [];

  const templateIds = [...new Set(rewards.map((row: any) => text(row.ticket_template_id)).filter(Boolean))];
  const [cardsResult, templatesResult] = await Promise.all([
    supabase.from("point_cards").select("id,card_id,title,status,style_key,expiry_mode,expires_on,sort_order").in("id", cardIds),
    templateIds.length
      ? supabase.from("ticket_templates").select("id,title,status").in("id", templateIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (cardsResult.error) {
    if (strict) throw cardsResult.error;
    return [];
  }
  if (templatesResult.error) {
    if (strict) throw templatesResult.error;
    return [];
  }

  const cards = cardsResult.data || [];
  const cardById = new Map(cards.map((row: any) => [text(row.id), row]));
  return selectLatestPointOffers(
    rewards,
    cardsResult.data || [],
    templatesResult.data || [],
    tickets,
    taipeiDate(),
    includeEveryTicket,
  ).slice(0, includeEveryTicket ? 200 : 12).map((offer) => {
    const card: any = cardById.get(offer.pointCardId);
    return { ...offer, cardId: text(card?.card_id), expiresOn: text(card?.expiry_mode) === "date" ? text(card?.expires_on) : "" };
  });
}

export async function loadLatestEventOffers(
  supabase: SupabaseClient,
  memberId: string,
  tierKey: string,
  strict: boolean,
  includeTierPreview = false,
): Promise<Array<CurrentEventOffer & { eventTicketId: string; startsOn: string; endsOn: string; allowedTierKeys: string[]; description: string; accent: string; ticketType: string; quota: number | null; claimedCount: number; fixedTicketTemplateId: string }>> {
  const today = taipeiDate();
  const eventsResult = await supabase
    .from("event_tickets")
    .select("id,event_ticket_id,title,description,accent,ticket_type,status,starts_on,ends_on,quota,allowed_tier_keys,fixed_ticket_template_id,requires_location,required_service_ids,required_service_match_mode,required_service_groups")
    .eq("status", "active")
    .is("deleted_at", null);
  if (eventsResult.error) {
    if (strict) throw eventsResult.error;
    return [];
  }

  const eligible = (eventsResult.data || []).filter((row: any) => {
    const allowed = Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [];
    return (!row.starts_on || text(row.starts_on) <= today) &&
      (!row.ends_on || text(row.ends_on) >= today) &&
      (includeTierPreview || allowed.includes(tierKey));
  });
  const ids = eligible.map((row: any) => row.id);
  if (!ids.length) return [];

  const [claimsResult, countsResult] = await Promise.all([
    supabase.from("event_ticket_claims")
      .select("claim_id,event_ticket_id,member_id,status")
      .eq("member_id", memberId)
      .in("event_ticket_id", ids),
    supabase.rpc("event_ticket_claim_counts", { p_event_ids: ids }),
  ]);
  if (claimsResult.error || countsResult.error) {
    if (strict) throw claimsResult.error || countsResult.error;
    return [];
  }

  const eventById = new Map(eligible.map((row: any) => [text(row.id), row]));
  const claimCountById = new Map<string, number>((countsResult.data || []).map((row: any) => [text(row.event_ticket_id), number(row.claimed_count)]));
  return selectLatestEventOffers(
    eligible,
    claimsResult.data || [],
    memberId,
    countsResult.data || [],
  ).slice(0, 8).map((offer) => {
    const event: any = eventById.get(offer.eventId);
    return {
      ...offer,
      description: text(event?.description), accent: text(event?.accent), ticketType: text(event?.ticket_type),
      claimedCount: claimCountById.get(offer.eventId) || 0,
      quota: event?.quota ?? null, fixedTicketTemplateId: text(event?.fixed_ticket_template_id),
      allowedTierKeys:Array.isArray(event?.allowed_tier_keys)?event.allowed_tier_keys:[],
      eventTicketId: text(event?.event_ticket_id),
      startsOn: text(event?.starts_on),
      endsOn: text(event?.ends_on),
      requiredServiceIds: Array.isArray(event?.required_service_ids)
        ? event.required_service_ids.map(text).filter(Boolean)
        : [],
      requiredServiceMatchMode: text(event?.required_service_match_mode) === "all" ? "all" : "any",
      ...(Array.isArray(event?.required_service_groups) && event.required_service_groups.length ? { requiredServiceGroups: event.required_service_groups } : {}),
    };
  });
}

export async function buildLatestAvailableOffersSection(
  supabase: SupabaseClient,
  memberId: string,
  tierKey: string,
  options: { strict?: boolean } = {},
): Promise<string> {
  const strict = options.strict === true;
  const [points, events] = await Promise.all([
    loadLatestPointOffers(supabase, memberId, strict),
    loadLatestEventOffers(supabase, memberId, tierKey, strict),
  ]);
  const pointLines = points.map((offer) => `・${offer.cardTitle}｜${offer.ticketTitle}｜消耗 ${offer.thresholdStamps} 點`);
  const eventLines = events.map((offer) => `・${offer.title}${offer.claimed ? "（已領取）" : "（可領取）"}`);

  const blocks: string[] = [];
  if (pointLines.length) blocks.push("集點卡優惠（目前設定）\n" + pointLines.join("\n"));
  if (eventLines.length) blocks.push("活動票券\n" + eventLines.join("\n"));
  return blocks.length
    ? "【目前可用優惠】\n" + blocks.join("\n\n")
    : "";
}
