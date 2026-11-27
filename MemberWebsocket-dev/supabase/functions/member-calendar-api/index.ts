import { businessEnv, businessFetch as fetch, serveBusiness } from '../_shared/business-runtime.ts';
import { tierVisibility, loadVisibilityPolicy } from "../_shared/tier-visibility.ts";
import { createClient } from '../_shared/business-runtime.ts';

type Json = Record<string, unknown>;
type CalendarItem = Json & {
  calendarItemId?: string;
  itemType?: string;
  startsOn?: string;
  endsOn?: string;
  status?: string;
  linkUrl?: string;
  allowedTierKeys?: string[];
  visibilityPolicy?: string;
  usageConditions?: unknown;
  usageEligible?: boolean;
  usageConditionLabel?: string;
};

const MAX_REQUEST_BYTES = 40_000;
const TIER_KEYS = ["general", "silver", "gold", "platinum"] as const;
const TIER_LABELS: Record<string, string> = {
  general: "一般會員",
  silver: "銀級會員",
  gold: "金級會員",
  platinum: "白金會員",
};

function env(name: string): string {
  return (businessEnv(name) || "").trim();
}

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function allowedOrigins(): Set<string> {
  return new Set([(env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io"), "https://develop--memberwebsocket-dev-netlify.netlify.app"].join(",")
    .split(",").map((value) => value.trim()).filter(Boolean));
}

function corsHeaders(origin: string | null): HeadersInit {
  const resolved = origin && allowedOrigins().has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": resolved,
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function reply(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function calendarClient(row: any): CalendarItem {
  return {
    calendarItemId: row.calendar_item_id,
    title: row.title,
    itemType: row.item_type,
    description: row.description || "",
    startsOn: row.starts_on,
    endsOn: row.ends_on || "",
    status: row.status === "targeted" ? "active" : row.status,
    accent: row.accent,
    allowedTierKeys: Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [],
    visibilityPolicy: row.visibility_policy || 'eligible_only',
    linkLabel: row.link_label || "",
    linkUrl: row.link_url || "",
    usageConditions: row.usage_conditions && typeof row.usage_conditions === 'object' ? row.usage_conditions : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


type UsageRule = {
  requiredServiceIds: string[];
  requiredServiceMatchMode: string;
  requiredServiceGroups: string[][];
  minBookingAmountMode: string;
  minBookingAmount: number;
  minBookingServiceIds: string[];
  minBookingPartySize: number;
  maxBookingPartySize: number;
};

function activityUsageRules(value: unknown): UsageRule {
  const rule: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    requiredServiceIds: Array.isArray(rule.requiredServiceIds) ? rule.requiredServiceIds.map(String) : [],
    requiredServiceMatchMode: String(rule.requiredServiceMatchMode || "any"),
    requiredServiceGroups: Array.isArray(rule.requiredServiceGroups)
      ? rule.requiredServiceGroups.filter((group: unknown) => Array.isArray(group)).map((group: string[]) => group.map(String)) : [],
    minBookingAmountMode: String(rule.minBookingAmountMode || "none"),
    minBookingAmount: Number(rule.minBookingAmount || 0),
    minBookingServiceIds: Array.isArray(rule.minBookingServiceIds) ? rule.minBookingServiceIds.map(String) : [],
    minBookingPartySize: Number(rule.minBookingPartySize || 0),
    maxBookingPartySize: Number(rule.maxBookingPartySize || 0),
  };
}

function activityRequiresBooking(rule: UsageRule): boolean {
  return rule.requiredServiceIds.length > 0 || rule.requiredServiceGroups.length > 0
    || rule.minBookingAmountMode !== "none" || rule.minBookingPartySize > 0 || rule.maxBookingPartySize > 0;
}

function usageConditionLabel(rule: UsageRule, serviceNames: Map<string,string>): string {
  if (!activityRequiresBooking(rule)) return "";
  const name = (id: string) => serviceNames.get(id) || "已停用項目";
  const clauses: string[] = [];
  if (rule.requiredServiceGroups.length) {
    clauses.push("預約「" + rule.requiredServiceGroups.map((group) => group.map(name).join("＋")).join("」或「") + "」其中一組");
  } else if (rule.requiredServiceIds.length) {
    clauses.push(rule.requiredServiceMatchMode === "all"
      ? "預約所有項目：「" + rule.requiredServiceIds.map(name).join("、") + "」"
      : "預約其中一項：「" + rule.requiredServiceIds.map(name).join("、") + "」");
  }
  if (rule.minBookingAmountMode !== "none") {
    const money = "NT$" + rule.minBookingAmount.toLocaleString("en-US");
    clauses.push(rule.minBookingAmountMode === "total"
      ? "整筆預約滿 " + money
      : "指定項目「" + rule.minBookingServiceIds.map(name).join("、") + "」合計滿 " + money);
  }
  if (rule.minBookingPartySize && rule.maxBookingPartySize) {
    clauses.push(rule.minBookingPartySize === rule.maxBookingPartySize
      ? "限 " + rule.minBookingPartySize + " 人"
      : "預約 " + rule.minBookingPartySize + "–" + rule.maxBookingPartySize + " 人");
  } else if (rule.minBookingPartySize) clauses.push("至少 " + rule.minBookingPartySize + " 人");
  else if (rule.maxBookingPartySize) clauses.push("最多 " + rule.maxBookingPartySize + " 人");
  return clauses.join(" · ");
}

function bookingSatisfiesActivity(
  booking: any, bookingItems: any[], rule: UsageRule,
): boolean {
  const party = Number(booking.party_size);
  if (!Number.isSafeInteger(party) || party < 1) return false;
  if (rule.minBookingPartySize > 0 && party < rule.minBookingPartySize) return false;
  if (rule.maxBookingPartySize > 0 && party > rule.maxBookingPartySize) return false;
  const serviceIds = new Set(bookingItems.map((item:any) => String(item.service_id || "")));
  if (rule.requiredServiceGroups.length) {
    if (!rule.requiredServiceGroups.some((group) => group.length > 0 && group.every((id) => serviceIds.has(id)))) return false;
  } else if (rule.requiredServiceIds.length) {
    const matches = rule.requiredServiceMatchMode === "all"
      ? rule.requiredServiceIds.every((id) => serviceIds.has(id))
      : rule.requiredServiceIds.some((id) => serviceIds.has(id));
    if (!matches) return false;
  }
  if (rule.minBookingAmountMode !== "none") {
    const total = bookingItems
      .filter((item:any) => rule.minBookingAmountMode === "total"
        || rule.minBookingServiceIds.includes(String(item.service_id || "")))
      .reduce((sum:number,item:any) => sum + Number(item.unit_price_amount || 0) * Number(item.quantity || 0),0);
    if (!Number.isSafeInteger(total) || total < rule.minBookingAmount) return false;
  }
  return true;
}

function birthdayMonth(value: unknown): number {
  const birthday = asText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return 0;
  const month = Number(birthday.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 0;
}

function normalizedTierKeys(item: CalendarItem): string[] {
  const keys = Array.isArray(item.allowedTierKeys)
    ? item.allowedTierKeys.filter((key) => TIER_KEYS.includes(String(key) as typeof TIER_KEYS[number]))
    : [];
  return keys.length ? [...new Set(keys.map(String))] : [...TIER_KEYS];
}

function decorateTierEligibility(item: CalendarItem, profile: Json): CalendarItem {
  if (String(item.itemType || "") !== "event") return item;
  const allowedTierKeys = normalizedTierKeys(item);
  const memberTierKey = asText(profile.tierKey || "general", 30);
  return {
    ...item,
    allowedTierKeys,
    allowedTierLabels: allowedTierKeys.map((key) => TIER_LABELS[key]).filter(Boolean),
    tierEligible: allowedTierKeys.includes(memberTierKey),
  };
}

function parseIsoDate(value: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asText(value, 10));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? date
    : null;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isManagedEventTicketCalendarItem(item: CalendarItem): boolean {
  if (String(item.itemType || "") !== "event") return false;
  try {
    const url = new URL(String(item.linkUrl || ""), "https://calendar.invalid/");
    return url.searchParams.get("source") === "event-ticket-calendar"
      && Boolean(asText(url.searchParams.get("eventTicketId"), 120));
  } catch {
    return false;
  }
}

function holidayDateSet(items: CalendarItem[]): Set<string> {
  const dates = new Set<string>();
  for (const item of items) {
    if (String(item.itemType || "") !== "holiday") continue;
    const status = String(item.status || "");
    if (status && status !== "active") continue;
    const start = parseIsoDate(item.startsOn);
    const end = parseIsoDate(item.endsOn || item.startsOn);
    if (!start || !end || end < start) continue;
    const current = new Date(start);
    let guard = 0;
    while (current <= end && guard < 370) {
      dates.add(toIsoDate(current));
      current.setUTCDate(current.getUTCDate() + 1);
      guard += 1;
    }
  }
  return dates;
}

function splitManagedEventAroundHolidays(item: CalendarItem, holidays: Set<string>): CalendarItem[] {
  // All member-visible events (including ticket-synced events) yield to holidays.
  const managedEventTicket = isManagedEventTicketCalendarItem(item);
  if (String(item.itemType || "") !== "event") return [item];
  const start = parseIsoDate(item.startsOn);
  const end = parseIsoDate(item.endsOn || item.startsOn);
  if (!start || !end || end < start) return [item];

  const segments: CalendarItem[] = [];
  let segmentStart = "";
  let segmentEnd = "";
  const current = new Date(start);
  let guard = 0;

  const pushSegment = () => {
    if (!segmentStart) return;
    segments.push({
      ...item,
      startsOn: segmentStart,
      endsOn: segmentEnd === segmentStart ? "" : segmentEnd,
      ...(managedEventTicket ? { calendarDisplaySourceId: String(item.calendarItemId || "") } : {}),
    });
    segmentStart = "";
    segmentEnd = "";
  };

  while (current <= end && guard < 370) {
    const date = toIsoDate(current);
    if (holidays.has(date)) {
      pushSegment();
    } else {
      if (!segmentStart) segmentStart = date;
      segmentEnd = date;
    }
    current.setUTCDate(current.getUTCDate() + 1);
    guard += 1;
  }
  pushSegment();
  return segments;
}

function applyCalendarDisplayRules(items: CalendarItem[]): CalendarItem[] {
  const holidays = holidayDateSet(items);
  if (!holidays.size) return items;
  return items.flatMap((item) => splitManagedEventAroundHolidays(item, holidays));
}

function includesDate(item: CalendarItem, date: string): boolean {
  const start = asText(item.startsOn, 10);
  const end = asText(item.endsOn || item.startsOn, 10);
  return Boolean(start && end && start <= date && end >= date);
}

async function verifyWithCoreApi(
  supabaseUrl: string,
  serviceRoleKey: string,
  body: Json,
): Promise<Json> {
  const verifiedResponse = await fetch(`${supabaseUrl}/functions/v1/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceRoleKey },
    body: JSON.stringify(body),
  });
  const verifiedText = await verifiedResponse.text();
  let verifiedPayload: any;
  try {
    verifiedPayload = JSON.parse(verifiedText);
  } catch {
    throw new Error("UPSTREAM_INVALID_RESPONSE");
  }
  if (!verifiedResponse.ok || verifiedPayload?.ok !== true) {
    return { __error: true, payload: verifiedPayload, status: Number(verifiedPayload?.status || verifiedResponse.status || 500) };
  }
  return verifiedPayload?.data && typeof verifiedPayload.data === "object" ? verifiedPayload.data : {};
}

serveBusiness('member-calendar-api',async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return reply(origin, { ok:false,status:405,error:{ code:"METHOD_NOT_ALLOWED",message:"只支援 POST。" } }, 405);
  if (origin && !allowedOrigins().has(origin)) return reply(origin, { ok:false,status:403,error:{ code:"ORIGIN_NOT_ALLOWED",message:"此網站來源未被允許使用會員日曆。" } }, 403);

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return reply(origin, { ok:false,status:413,error:{ code:"REQUEST_TOO_LARGE",message:"請求內容過大。" } }, 413);
    }

    let body: Json;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return reply(origin, { ok:false,status:400,error:{ code:"INVALID_JSON",message:"請求內容必須是有效 JSON。" } }, 400);
    }

    const action = asText(body.action, 80);
    if (!["user.calendar.bootstrap", "user.calendar.date.details"].includes(action)) {
      return reply(origin, { ok:false,status:404,error:{ code:"ACTION_NOT_FOUND",message:"不支援的會員日曆操作。" } }, 404);
    }
    if (asText(body.clientType, 20) !== "calendar") {
      return reply(origin, { ok:false,status:400,error:{ code:"CLIENT_TYPE_MISMATCH",message:"Client type 與 API action 不一致。" } }, 400);
    }
    if (!asText(body.idToken, 10_000) && !asText(body.testSessionToken, 200)) {
      return reply(origin, { ok:false,status:401,error:{ code:"AUTH_REQUIRED",message:"需要 LINE 登入。" } }, 401);
    }

    const supabaseUrl = env("SUPABASE_URL");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return reply(origin, { ok:false,status:503,error:{ code:"SUPABASE_CONFIG_MISSING",message:"會員日曆服務設定尚未完成。" } }, 503);
    }

    const verified = await verifyWithCoreApi(supabaseUrl, serviceRoleKey, body);
    if (verified.__error === true) {
      return reply(origin, verified.payload, Number(verified.status || 500));
    }

    const profile = verified.profile && typeof verified.profile === "object"
      ? verified.profile as Json
      : null;
    if (!profile || !asText(profile.lineUserId, 120)) {
      return reply(origin, { ok:false,status:401,error:{ code:"AUTH_INVALID",message:"無法確認會員身分。" } }, 401);
    }

    const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession:false, autoRefreshToken:false } });
    const [result, eventTicketsResult] = await Promise.all([
      db.from("calendar_items")
        .select("*")
        .in("status", ["active", "targeted"])
        .order("starts_on", { ascending:true })
        .order("created_at", { ascending:true }),
      db.from("event_tickets")
        .select("id,event_ticket_id,title,description,starts_on,ends_on,status,accent,allowed_tier_keys,validity_mode,visibility_policy")
        .eq("status", "active")
        .is("deleted_at", null)
        .is("referral_source_event_ticket_id", null)
        .is("fixed_ticket_template_id", null),
    ]);
    if (result.error || eventTicketsResult.error) {
      return reply(origin, { ok:false,status:500,error:{ code:"DATABASE_ERROR",message:"營運日曆暫時無法讀取。" } }, 500);
    }

    const memberBirthdayMonth = birthdayMonth(profile.birthday);
    const rows = (result.data || []).filter((row:any) => {
      const audienceType = asText(row.audience_type || "all", 30);
      if (row.status === "targeted" && audienceType !== "birthday_month") return false;
      if (audienceType !== "birthday_month") return row.status === "active";
      return row.status === "targeted"
        && memberBirthdayMonth > 0
        && Number(row.audience_month || 0) === memberBirthdayMonth;
    });

    // Explicit calendar_items are the only source of member-facing calendar entries.
    // An active event ticket alone must never publish an activity to the calendar.
    const eventByUuid = new Map((eventTicketsResult.data || []).map((ticket: any) => [String(ticket.id), ticket]));
    const eventByCode = new Map((eventTicketsResult.data || []).map((ticket: any) => [String(ticket.event_ticket_id), ticket]));
    const calendarEntries: CalendarItem[] = rows.map((row: any): CalendarItem => {
      const item = calendarClient(row);
      if (item.itemType !== 'event') return item;
      let linkedTicket = eventByUuid.get(String(row.source_event_ticket_id || ''));
      if (!linkedTicket) {
        try {
          const link = new URL(String(row.link_url || ''), 'https://calendar.invalid/');
          if (link.searchParams.get('source') === 'event-ticket-calendar')
            linkedTicket = eventByCode.get(String(link.searchParams.get('eventTicketId') || ''));
        } catch { /* No ticket association: preserve the saved activity visibility rules. */ }
      }
      return linkedTicket ? { ...item, allowedTierKeys: Array.isArray(linkedTicket.allowed_tier_keys) ? linkedTicket.allowed_tier_keys : [], visibilityPolicy: linkedTicket.visibility_policy || 'eligible_only' } : item;
    });
    // The linked member ID, booking ownership, confirmation state and items are
    // read with the tenant-scoped service client. No browser-supplied count is trusted.
    const gatedEntries = calendarEntries.filter((item) => item.itemType === "event"
      && activityRequiresBooking(activityUsageRules(item.usageConditions)));
    const memberBookings: any[] = [];
    const bookedItemsByBooking = new Map<string, any[]>();
    const serviceNames = new Map<string,string>();
    if (gatedEntries.length) {
      const memberRes = await db.from("members").select("id").eq("line_user_id",profile.lineUserId).maybeSingle();
      if (memberRes.error || !memberRes.data?.id) {
        return reply(origin,{ok:false,status:401,error:{code:"MEMBER_NOT_FOUND",message:"無法確認目前會員身分。"}},401);
      }
      const bookings = await db.from("bookings")
        .select("id,party_size,cancellation_requested_at,cancellation_reviewed_at")
        .eq("member_id",memberRes.data.id).eq("status","confirmed").is("completed_at",null);
      if (bookings.error) {
        return reply(origin,{ok:false,status:500,error:{code:"DATABASE_ERROR",message:"無法確認活動預約資格。"}},500);
      }
      memberBookings.push(...(bookings.data || []).filter((booking:any) =>
        !(booking.cancellation_requested_at && !booking.cancellation_reviewed_at)));
      if (memberBookings.length) {
        const bookingItems = await db.from("booking_items")
          .select("booking_id,service_id,unit_price_amount,quantity")
          .in("booking_id",memberBookings.map((booking:any) => booking.id));
        if (bookingItems.error) {
          return reply(origin,{ok:false,status:500,error:{code:"DATABASE_ERROR",message:"無法確認活動預約項目。"}},500);
        }
        for (const item of bookingItems.data || []) {
          const bookingId = String(item.booking_id);
          const items = bookedItemsByBooking.get(bookingId) || [];
          items.push(item);
          bookedItemsByBooking.set(bookingId,items);
        }
      }
      const ids = [...new Set(gatedEntries.flatMap((item) => {
        const rule = activityUsageRules(item.usageConditions);
        return [...rule.requiredServiceIds,...rule.requiredServiceGroups.flat(),...rule.minBookingServiceIds];
      }))];
      if (ids.length) {
        const services = await db.from("booking_services").select("id,title").in("id",ids);
        if (services.error) {
          return reply(origin,{ok:false,status:500,error:{code:"DATABASE_ERROR",message:"無法確認活動指定服務項目。"}},500);
        }
        for (const service of services.data || []) serviceNames.set(String(service.id),String(service.title || ""));
      }
    }
    let items = calendarEntries.map((item) => decorateTierEligibility(item, profile));
    // Keep the response shape for existing clients, but never synthesize
    // ongoing activities from tickets that were not opted into the calendar.
    const ongoingTickets: CalendarItem[] = [];
    const policy=await loadVisibilityPolicy(db);
    const visibility = (item:CalendarItem): CalendarItem[] => {
      const v = tierVisibility(item.allowedTierKeys, profile.tierKey, item.visibilityPolicy || policy);
      return item.itemType === "holiday" ? [item] : v.visible ? [{ ...item, ...v }] : [];
    };
    items=items.flatMap(visibility).map((item) => {
      if (item.itemType !== "event") return item;
      const rule = activityUsageRules(item.usageConditions);
      const label = usageConditionLabel(rule,serviceNames);
      if (!activityRequiresBooking(rule)) return {...item,usageEligible:true,usageConditionLabel:""};
      const eligible = memberBookings.some((booking:any) =>
        bookingSatisfiesActivity(booking,bookedItemsByBooking.get(String(booking.id)) || [],rule));
      return {...item,usageEligible:eligible,usageConditionLabel:label,
        locked:item.locked === true || !eligible,
        lockReason:item.locked === true ? item.lockReason : eligible ? "" : "需要已確認且符合使用條件的預約才能參加。"};
    });
    items = applyCalendarDisplayRules(items);

    if (action === "user.calendar.date.details") {
      const date = asText(body.date, 10);
      if (!parseIsoDate(date)) {
        return reply(origin, { ok:false,status:400,error:{ code:"INVALID_DATE",message:"日期格式不正確。" } }, 400);
      }
      items = items.filter((item) => includesDate(item, date));
    }

    return reply(origin, { ok:true,status:200,data:{ profile,items,ongoingTickets:action === "user.calendar.bootstrap" ? ongoingTickets : [] } }, 200);
  } catch (error) {
    const code = error instanceof Error && error.message === "UPSTREAM_INVALID_RESPONSE"
      ? "UPSTREAM_INVALID_RESPONSE"
      : "CALENDAR_SERVICE_UNAVAILABLE";
    const message = code === "UPSTREAM_INVALID_RESPONSE"
      ? "會員驗證服務暫時無法正常回應。"
      : "會員日曆服務暫時無法使用。";
    return reply(origin, { ok:false,status:503,error:{ code,message } }, 503);
  }
});
