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
};

const MAX_REQUEST_BYTES = 40_000;
const TIER_KEYS = ["general", "silver", "gold", "platinum"] as const;
const TIER_LABELS: Record<string, string> = {
  general: "銅級會員",
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
    requiredServiceIds: Array.isArray(row.required_service_ids)?row.required_service_ids:[],
    requiredServiceMatchMode: Array.isArray(row.required_service_groups)&&row.required_service_groups.length?'groups':row.required_service_match_mode||'any',
    requiredServiceGroups: Array.isArray(row.required_service_groups)?row.required_service_groups:[],
    minBookingAmountMode: row.min_booking_amount_mode||'none',
    minBookingAmount: Number(row.min_booking_amount||0),
    minBookingServiceIds: Array.isArray(row.min_booking_service_ids)?row.min_booking_service_ids:[],
    minBookingPartySize: Number(row.min_booking_party_size||0),
    maxBookingPartySize: Number(row.max_booking_party_size||0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activityUsageLabels(item: CalendarItem, titles: Map<string,string>): string[] {
  const ids = Array.isArray(item.requiredServiceIds)?item.requiredServiceIds:[];
  const groups = Array.isArray(item.requiredServiceGroups)?item.requiredServiceGroups:[];
  const title = (id: unknown) => titles.get(String(id)) || '已停用項目';
  const result: string[] = [];
  if (groups.length) result.push('需預約以下任一組合：'+groups.map((group:any)=>Array.isArray(group)?group.map(title).join('＋'):'資料異常').join(' 或 '));
  else if (ids.length) result.push(item.requiredServiceMatchMode==='all'
    ? '需預約所有指定項目：'+ids.map(title).join('、')
    : '需預約任一指定項目：'+ids.map(title).join('、'));
  const mode=String(item.minBookingAmountMode||'none');
  const amount=Number(item.minBookingAmount||0);
  if (mode!=='none') {
    const price='NT'+String.fromCharCode(36)+amount.toLocaleString('en-US');
    const amountIds=Array.isArray(item.minBookingServiceIds)?item.minBookingServiceIds:[];
    result.push(mode==='total'?'預約總金額至少 '+price:mode==='selected_services'&&amountIds.length
      ? '指定項目「'+amountIds.map(title).join('、')+'」合計至少 '+price
      : '預約金額條件資料異常，請洽店家');
  }
  const min=Number(item.minBookingPartySize||0), max=Number(item.maxBookingPartySize||0);
  if (min>0 && max===min) result.push(`每筆預約須剛好 ${min} 位`);
  else if (min>0 && max>0) result.push(`每筆預約需 ${min}–${max} 位（舊版區間條件）`);
  else if (min>0) result.push(`每筆預約至少 ${min} 位`);
  else if (max>0) result.push(`每筆預約最多 ${max} 位`);
  return result;
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
    const [result, eventTicketsResult, bookingServicesResult] = await Promise.all([
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
      db.from("booking_services").select("id,title"),
    ]);
    if (result.error || eventTicketsResult.error || bookingServicesResult.error) {
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
    const serviceTitles = new Map<string,string>((bookingServicesResult.data||[]).map((row:any)=>[String(row.id),String(row.title||'已停用項目')]));
    const eventByUuid = new Map((eventTicketsResult.data || []).map((ticket: any) => [String(ticket.id), ticket]));
    const eventByCode = new Map((eventTicketsResult.data || []).map((ticket: any) => [String(ticket.event_ticket_id), ticket]));
    const calendarEntries = rows.map((row: any) => {
      const item = calendarClient(row);
      if (item.itemType !== 'event') return item;
      item.usageConditionLabels=activityUsageLabels(item,serviceTitles);
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
    let items = calendarEntries.map((item) => decorateTierEligibility(item, profile));
    // Keep the response shape for existing clients, but never synthesize
    // ongoing activities from tickets that were not opted into the calendar.
    const ongoingTickets: CalendarItem[] = [];
    const policy=await loadVisibilityPolicy(db);
    const visibility = (item:CalendarItem): CalendarItem[] => {
      const v = tierVisibility(item.allowedTierKeys, profile.tierKey, item.visibilityPolicy || policy);
      return item.itemType === "holiday" ? [item] : v.visible ? [{ ...item, ...v }] : [];
    };
    items=items.flatMap(visibility);
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
