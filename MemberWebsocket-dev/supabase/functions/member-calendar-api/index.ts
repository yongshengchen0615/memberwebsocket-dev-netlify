import { tierVisibility, loadVisibilityPolicy } from "../_shared/tier-visibility.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

type Json = Record<string, unknown>;
type CalendarItem = Json & {
  calendarItemId?: string;
  itemType?: string;
  startsOn?: string;
  endsOn?: string;
  status?: string;
  linkUrl?: string;
  allowedTierKeys?: string[];
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
  return (Deno.env.get(name) || "").trim();
}

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function allowedOrigins(): Set<string> {
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io")
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
    linkLabel: row.link_label || "",
    linkUrl: row.link_url || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  if (!isManagedEventTicketCalendarItem(item)) return [item];
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
      calendarDisplaySourceId: String(item.calendarItemId || ""),
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

Deno.serve(async (request: Request) => {
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
    const result = await db.from("calendar_items")
      .select("*")
      .in("status", ["active", "targeted"])
      .order("starts_on", { ascending:true })
      .order("created_at", { ascending:true });
    if (result.error) {
      return reply(origin, { ok:false,status:500,error:{ code:"DATABASE_ERROR",message:"活動日曆暫時無法讀取。" } }, 500);
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

    let items = rows
      .map(calendarClient)
      .map((item) => decorateTierEligibility(item, profile));
    const policy=await loadVisibilityPolicy(db);
    items=items.flatMap(item=>{const v=tierVisibility(item.allowedTierKeys,profile.tierKey,policy);return item.itemType==='holiday'?[item]:v.visible?[{...item,...v}]:[];});
    items = applyCalendarDisplayRules(items);

    if (action === "user.calendar.date.details") {
      const date = asText(body.date, 10);
      if (!parseIsoDate(date)) {
        return reply(origin, { ok:false,status:400,error:{ code:"INVALID_DATE",message:"日期格式不正確。" } }, 400);
      }
      items = items.filter((item) => includesDate(item, date));
    }

    return reply(origin, { ok:true,status:200,data:{ profile,items } }, 200);
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
