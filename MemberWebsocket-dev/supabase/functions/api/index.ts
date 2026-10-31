import { businessEnv, businessContext, businessFetch as fetch, businessHandler } from '../_shared/business-runtime.ts';
import { syncRevision } from '../_shared/sync-revision.mjs';
import { removeMember } from "../_shared/member-removal.ts";
import { tierVisibility, loadVisibilityPolicy } from "../_shared/tier-visibility.ts";
import { bookingTicketUsageError, ticketBookingId } from "../_shared/booking-ticket-usage.ts";
import { loadBookingBenefits } from "../_shared/booking-benefits.ts";
import { loadMemberBookingSelections, contextsForTicket } from "../_shared/booking-selection-context.ts";
import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { buildLineFlexNotice } from "../_shared/line-flex.ts";
import { resolveTestSession, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import { createClient, SupabaseClient } from '../_shared/business-runtime.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

type ClientType = "member" | "points" | "event" | "calendar" | "booking" | "admin";
type Json = Record<string, unknown>;

const MAX_REQUEST_BYTES = 40_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;
const TIER_KEYS = ["general", "silver", "gold", "platinum"] as const;
const TIER_LABELS: Record<string,string> = { general:"一般會員",silver:"銀級會員",gold:"金級會員",platinum:"白金會員" };
const STYLE_KEYS = ["forest","midnight","ocean","sunset","lavender","rose","gold","platinum","mint","cherry"] as const;
const POINT_CARD_STYLE_KEYS = ["citrus","coral","lagoon","skyline","violet","berry","cocoa","lime","denim","peach"] as const;
const LEGACY_POINT_CARD_STYLE_MAP: Record<string,string> = { forest:"lagoon",midnight:"skyline",ocean:"denim",sunset:"coral",lavender:"violet",rose:"berry",gold:"citrus",platinum:"cocoa",mint:"lime",cherry:"peach" };
const PRESENCE_ONLINE_WINDOW_MS = 90_000;
const PRESENCE_ACTIONS = [
  "user.member.presence.online","user.member.presence.offline",
  "user.pointcard.presence.online","user.pointcard.presence.offline",
  "user.event.presence.online","user.event.presence.offline",
  "user.calendar.presence.online","user.calendar.presence.offline",
  "user.booking.presence.online","user.booking.presence.offline",
] as const;
const PRESENCE_HEARTBEAT_ACTIONS = [
  "user.member.presence.heartbeat",
  "user.pointcard.presence.heartbeat",
  "user.event.presence.heartbeat",
  "user.calendar.presence.heartbeat",
  "user.booking.presence.heartbeat",
] as const;
const WRITE_ACTIONS = new Set([
  ...PRESENCE_ACTIONS,
  ...PRESENCE_HEARTBEAT_ACTIONS,
  "user.member.profile.save",
  "admin.terms.draft.save",
  "admin.terms.activate",
  "admin.member.update",
  "admin.member.force-logout",
  "admin.member.remove",
  "admin.member-tiers.save",
  "admin.settings.copy",
  "admin.ticket-visibility.save",
  "admin.pointcards.save",
  "admin.pointcards.reorder",
  "admin.pointcards.archive",
  "admin.pointcards.delete",
  "admin.pointcards.remove",
  "admin.tickets.save",
  "admin.tickets.delete",
  "admin.event-tickets.save",
  "admin.event-tickets.delete",
  "admin.calendar-items.save",
  "admin.calendar-items.delete",
  "admin.calendar-items.batch",
  "admin.stamps.add",
  "admin.service_minutes.add",
  "admin.member-grants.add",
  "admin.service-grants.add",
  "admin.grant-message-presets.save",
  "user.pointcard.ticket.redeem",
  "user.pointcard.snapshot-ticket.cancel",
  "user.event.snapshot-ticket.cancel",
  "user.event.ticket.claim",
  "user.event.ticket.redeem",
  "user.booking.event-ticket.claim",
  "user.pointcard.booking-selections.update",
  "user.event.booking-selections.update",
]);

class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function env(name: string): string {
  return (businessEnv(name) || "").trim();
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://yongshengchen0615.github.io",
  "https://memberwebsocket-dev-netlify.netlify.app",
  "https://develop--memberwebsocket-dev-netlify.netlify.app",
  "https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app",
];

function allowedOrigins(): Set<string> {
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...env("ALLOWED_ORIGINS").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
}

function corsHeaders(origin: string | null): HeadersInit {
  const resolved = origin && allowedOrigins().has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": resolved,
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type":"application/json; charset=utf-8" },
  });
}

function errorResponse(origin: string | null, error: unknown): Response {
  const apiError = error instanceof ApiError ? error : mapDatabaseError(error);
  return json(origin, {
    ok: false,
    status: apiError.status,
    error: { code: apiError.code, message: apiError.message, details: apiError.details },
  }, apiError.status);
}

function mapDatabaseError(error: unknown): ApiError {
  const bookingError = bookingTicketUsageError(error, (status, code, message) => new ApiError(status, code, message));
  if (bookingError) return bookingError as ApiError;
  const message = String((error as { message?: string })?.message || "");
  const rules: Array<[string, number, string, string]> = [
    ["BOOKING_CONFLICT",409,"BOOKING_CONFLICT","預約已被更新，請重新載入票券後再選擇。"],
    ["RECEIPT_NOT_PENDING",409,"RECEIPT_NOT_PENDING","快照已審核或不再等待審核，無法取消票券。"],
    ["RECEIPT_NOT_OWNED",403,"RECEIPT_NOT_OWNED","不可操作其他會員的快照。"],
    ["BOOKING_NOT_EDITABLE",409,"BOOKING_NOT_EDITABLE","這筆預約已結算或不能修改票券，請更新資料。"],
    ["BOOKING_BENEFIT_ALREADY_USED",409,"BOOKING_BENEFIT_ALREADY_USED","已核銷的票券不能再增減。"],
    ["BOOKING_BENEFIT_NOT_AVAILABLE",409,"BOOKING_BENEFIT_NOT_AVAILABLE","其中一張票券已失效，請更新票券資料。"],
    ["BOOKING_POINT_TICKET_LIMIT_EXCEEDED",409,"BOOKING_POINT_TICKET_LIMIT_EXCEEDED","超過本次集點卡票券使用上限。"],
    ["BOOKING_EVENT_TICKET_LIMIT_EXCEEDED",409,"BOOKING_EVENT_TICKET_LIMIT_EXCEEDED","超過活動票券每日使用上限。"],
    ["POINT_TICKET_INSUFFICIENT_POINTS",409,"POINT_TICKET_INSUFFICIENT_POINTS","可用點數不足，請減少選用票券。"],
    ["booking_benefit_selections_one_pending_ticket_idx",409,"BOOKING_BENEFIT_RESERVED","票券已被另一筆預約選用，請更新資料。"],
    ["INVALID_BOOKING_BENEFITS",400,"INVALID_BOOKING_BENEFITS","票券選取內容不正確，請重新選擇。"],
    ["INVALID_AUDIT_QUERY",400,"INVALID_AUDIT_QUERY","查詢日期不可超過一年，請確認篩選條件。"],
    ["ADMIN_REQUIRED",403,"ADMIN_REQUIRED","您沒有查詢操作稽核的權限。"],
    ["TERMS_CONSENT_REQUIRED",400,"TERMS_CONSENT_REQUIRED","請閱讀並同意會員條款。"],
    ["TERMS_VERSION_STALE",409,"TERMS_VERSION_STALE","會員條款已更新，請重新閱讀並確認。"],
    ["TERMS_UNAVAILABLE",503,"TERMS_UNAVAILABLE","目前尚無有效會員條款。"],
    ["TERMS_IMMUTABLE",409,"TERMS_IMMUTABLE","已發佈條款不可修改。"],
    ["TERMS_NOT_EFFECTIVE",400,"TERMS_NOT_EFFECTIVE","條款尚未生效或未設為必須同意。"],
    ["COPY_SOURCE_NOT_FOUND",404,"COPY_SOURCE_NOT_FOUND","找不到可複製的已儲存設定。"],
    ["INVALID_COPY_INPUT",400,"INVALID_COPY_INPUT","請填寫有效名稱與操作識別。"],
    ["INVALID_COPY_KIND",400,"INVALID_COPY_KIND","不支援此設定類型。"],
    ["ADMIN_REQUIRED",403,"ADMIN_REQUIRED","管理員權限不足。"],
    ["INVALID_TERMS",400,"INVALID_TERMS","條款內容不完整或格式不正確。"],
    ["CONFLICT",409,"CONFLICT","資料已被其他操作更新，請重新整理後再試。"],
    ["MEMBERSHIP_REQUIRED",403,"MEMBERSHIP_REQUIRED","請先完成會員加入後再使用此功能。"],
    ["MEMBER_NOT_FOUND",404,"MEMBER_NOT_FOUND","找不到指定會員。"],
    ["POINT_CARD_NOT_FOUND",404,"POINT_CARD_NOT_FOUND","找不到指定集點卡。"],
    ["POINT_CARD_NOT_AVAILABLE",409,"POINT_CARD_NOT_AVAILABLE","這張集點卡目前無法使用。"],
    ["POINT_CARD_EXPIRED",409,"POINT_CARD_EXPIRED","這張集點卡已超過使用期限。"],
    ["INSUFFICIENT_POINTS",409,"INSUFFICIENT_POINTS","目前點數不足，無法使用這張票券。"],
    ["TICKET_NOT_FOUND",404,"TICKET_NOT_FOUND","找不到這張票券。"],
    ["TICKET_NOT_AVAILABLE",409,"TICKET_NOT_AVAILABLE","這張票券目前無法使用。"],
    ["TICKET_TEMPLATE_IN_USE",409,"TICKET_TEMPLATE_IN_USE","這張票券仍被集點卡兌換節點引用，請先從相關集點卡移除該節點後再刪除。"],
    ["TICKET_TEMPLATE_DELETE_NOT_FOUND",404,"TICKET_TEMPLATE_DELETE_NOT_FOUND","找不到指定的集點卡票券。"],
    ["INVALID_TICKET_TEMPLATE_VERSION",400,"INVALID_TICKET_TEMPLATE_VERSION","票券資料版本無效，請重新整理。"],
    ["TICKET_TEMPLATE_NOT_FOUND",400,"TICKET_TEMPLATE_NOT_FOUND","選取的票券不存在。"],
    ["EVENT_TICKET_DAILY_LIMIT_REACHED",409,"EVENT_TICKET_DAILY_LIMIT_REACHED","今日活動票券使用張數已達上限，請於明日再使用。"],
    ["EVENT_TICKET_NOT_AVAILABLE",409,"EVENT_TICKET_NOT_AVAILABLE","這張活動票券目前無法使用。"],
    ["EVENT_NOT_STARTED",409,"EVENT_NOT_STARTED","活動尚未開始。"],
    ["EVENT_ENDED",409,"EVENT_ENDED","活動已結束。"],
    ["EVENT_QUOTA_REACHED",409,"EVENT_QUOTA_REACHED","活動票券已達發放上限。"],
    ["REFERRAL_TICKET_AUTO_ONLY",409,"REFERRAL_TICKET_AUTO_ONLY","好友邀請票券只能在好友邀請綁定成功後由系統發放。"],
    ["MEMBERSHIP_JOIN_TICKET_AUTO_ONLY",409,"MEMBERSHIP_JOIN_TICKET_AUTO_ONLY","加入會員票券只能在會員完成加入時由系統發放。"],
    ["event_tickets_one_active_referral_idx",409,"REFERRAL_REWARD_ALREADY_ACTIVE","同時間只能啟用一個好友邀請票券。"],
    ["event_tickets_one_active_membership_join_idx",409,"MEMBERSHIP_JOIN_REWARD_ALREADY_ACTIVE","同時間只能啟用一個加入會員票券。"],
    ["TIER_NOT_ALLOWED",403,"TIER_NOT_ALLOWED","目前會員等級不適用這張票券。"],
    ["CLAIM_NOT_FOUND",404,"CLAIM_NOT_FOUND","找不到已領取的活動票券。"],
    ["CLAIM_NOT_AVAILABLE",409,"CLAIM_NOT_AVAILABLE","這張活動票券目前無法使用。"],
    ["LOCATION_REQUIRED",400,"LOCATION_REQUIRED","核銷前請允許定位並取得目前位置。"],
    ["LOCATION_INVALID",400,"LOCATION_INVALID","定位精度不足或資料已過期，請重新定位。"],
    ["LOCATION_OUT_OF_RANGE",403,"LOCATION_OUT_OF_RANGE","目前不在此票券的核銷範圍內。"],
    ["INVALID_REQUEST_ID",400,"INVALID_REQUEST_ID","操作識別碼格式不正確。"],
    ["INVALID_POINT_AMOUNT",400,"INVALID_POINT_AMOUNT","點數必須是 1–100 的整數。"],
    ["SERVICE_GRANT_PREVIEW_STALE",409,"SERVICE_GRANT_PREVIEW_STALE","服務設定已變更，請重新預覽並確認發放。"],
    ["GRANT_REQUEST_CONFLICT",409,"GRANT_REQUEST_CONFLICT","此操作識別碼已用於其他發放內容，請重新開始。"],
    ["INVALID_SERVICE_ITEMS",400,"INVALID_SERVICE_ITEMS","請選擇有效服務項目與 1–2 的整數數量。"],
    ["SERVICE_NOT_AVAILABLE",409,"SERVICE_NOT_AVAILABLE","服務項目已停用、刪除或重複選取，請重新選擇。"],
    ["SERVICE_COMPANION_REQUIRED",400,"SERVICE_COMPANION_REQUIRED","加購項目需與主要服務一起登記。"],
    ["MEMBER_NOT_AVAILABLE",409,"MEMBER_NOT_AVAILABLE","此會員尚未啟用或完成加入，無法依服務登記發放。"],
    ["EMPTY_GRANT",400,"EMPTY_GRANT","所選服務未設定可發放的點數或會員服務時間。"],
    ["INVALID_SERVICE_MINUTES",400,"INVALID_SERVICE_MINUTES","服務時間必須是 1–1440 分鐘。"],
    ["INVALID_TIER_SETTINGS",400,"INVALID_TIER_SETTINGS","會員等級門檻設定不合法。"],
    ["INVALID_CARD_ORDERS",400,"INVALID_CARD_ORDERS","集點卡排序資料不合法。"],
    ["INVALID_REQUIRED_SERVICE_IDS",400,"INVALID_REQUIRED_SERVICE_IDS","票券指定的預約項目無效，請重新選擇。"],
    ["INVALID_REQUIRED_SERVICE_GROUPS",400,"INVALID_REQUIRED_SERVICE_GROUPS","票券預約組合無效，請重新設定。"],
    ["BOOKING_SERVICE_IN_USE",409,"BOOKING_SERVICE_IN_USE","此預約項目仍被票券使用條件引用，請先移除票券限制。"],
    ["INVALID_CALENDAR_BATCH",400,"INVALID_CALENDAR_BATCH","日曆批次操作必須是 1–20 筆。"],
    ["CALENDAR_ITEM_NOT_FOUND",404,"CALENDAR_ITEM_NOT_FOUND","找不到日曆項目。"],
  ];
  for (const [needle,status,code,userMessage] of rules) {
    if (message.includes(needle)) return new ApiError(status,code,userMessage);
  }
  return new ApiError(500,"DATABASE_ERROR","資料庫暫時無法完成操作。");
}

function presenceActionInfo(action: string): { clientType: ClientType; surface: string; event: "online"|"offline"|"heartbeat" } | null {
  const match = /^user\.(member|pointcard|event|calendar|booking)\.presence\.(online|offline|heartbeat)$/.exec(action);
  if (!match) return null;
  const clientTypeBySurface: Record<string,ClientType> = {
    member:"member", pointcard:"points", event:"event", calendar:"calendar", booking:"booking",
  };
  const surfaceByAction: Record<string,string> = {
    member:"member", pointcard:"points", event:"event", calendar:"calendar", booking:"booking",
  };
  return {
    clientType:clientTypeBySurface[match[1]],
    surface:surfaceByAction[match[1]],
    event:match[2] as "online"|"offline"|"heartbeat",
  };
}

function clientTypeForAction(action: string): ClientType {
  const sync = /^user\.(member|points|event|calendar|booking)\.sync\.status$/.exec(action);
  if (sync) return sync[1] as ClientType;
  if (action.startsWith("user.pointcard.booking-selections.")) return "points";
  if (action === "user.pointcard.snapshot-ticket.cancel") return "points";
  if (action.startsWith("user.event.booking-selections.")) return "event";
  if (action === "user.event.snapshot-ticket.cancel") return "event";
  const memberSession = /^user\.(member|points|event|calendar|booking)\.session\.(claim|logout|status)$/.exec(action);
  if (memberSession) return memberSession[1] as ClientType;
  if (action === "admin.session.claim" || action === "admin.session.logout") return "admin";
  const presence = presenceActionInfo(action);
  if (presence) return presence.clientType;
  if (action === "user.member.bootstrap" || action === "user.member.profile.save" || action === "user.member.terms.accept") return "member";
  if (action === "user.pointcard.bootstrap" || action === "user.pointcard.detail" || action.startsWith("user.pointcard.ticket.")) return "points";
  if (action === "user.event.bootstrap" || action === "user.event.ticket.detail" || action.startsWith("user.event.ticket.")) return "event";
  if (action === "user.calendar.bootstrap" || action === "user.calendar.date.details") return "calendar";
  if (action === "user.booking.benefits" || action === "user.booking.event-ticket.claim") return "booking";
  if (action.startsWith("admin.")) return "admin";
  throw new ApiError(404,"ACTION_NOT_FOUND","不支援的 API action。");
}

function channelIdFor(clientType: ClientType): string {
  const keys: Record<ClientType,string> = {
    member: "LINE_MEMBER_CHANNEL_ID",
    points: "LINE_POINTS_CHANNEL_ID",
    event: "LINE_EVENT_CHANNEL_ID",
    calendar: "LINE_CALENDAR_CHANNEL_ID",
    booking: "LINE_MEMBER_CHANNEL_ID",
    admin: "LINE_ADMIN_CHANNEL_ID",
  };
  const defaults: Record<ClientType,string> = {
    member: "2010787602",
    points: "2010787602",
    event: "2010787602",
    calendar: "2010787602",
    booking: "2010787602",
    admin: "2010791619",
  };
  const value = env(keys[clientType]) || defaults[clientType];
  if (!/^\d{5,30}$/.test(value)) throw new ApiError(503,"AUTH_CONFIG_MISSING","LINE 驗證設定尚未完成。");
  return value;
}

async function verifyLineIdToken(idToken: string, clientType: ClientType, allowLoginClaim = false): Promise<{ lineUserId: string; displayName: string; issuedAtMs: number }> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: channelIdFor(clientType),
    allowLoginClaim,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503,"SUPABASE_CONFIG_MISSING","Supabase server 設定尚未完成。");
  return createClient(url,key,{ auth: { persistSession: false, autoRefreshToken: false } });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2,"0")).join("");
}

function requestId(prefix = "REQ"): string {
  return prefix + "-" + crypto.randomUUID().replaceAll("-","");
}

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0,max);
}

function requireText(value: unknown, label: string, max = 100): string {
  const text = asText(value,max);
  if (!text) throw new ApiError(400,"INVALID_INPUT",label + "不可空白。");
  return text;
}

function requireStatus(value: unknown): "active"|"draft"|"archived" {
  const status = asText(value,20);
  if (!["active","draft","archived"].includes(status)) throw new ApiError(400,"INVALID_STATUS","請選擇公開狀態。");
  return status as "active"|"draft"|"archived";
}

function requireAccent(value: unknown): string {
  const color = asText(value,20);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ApiError(400,"INVALID_ACCENT","識別色格式不正確。");
  return color.toLowerCase();
}

function safeStyle(value: unknown): string {
  const style = asText(value,30);
  return (STYLE_KEYS as readonly string[]).includes(style) ? style : "forest";
}

function safePointCardStyle(value: unknown): string {
  const style = asText(value,30).toLowerCase();
  if ((POINT_CARD_STYLE_KEYS as readonly string[]).includes(style)) return style;
  return LEGACY_POINT_CARD_STYLE_MAP[style] || POINT_CARD_STYLE_KEYS[0];
}

function normalizeTierKeys(value: unknown, allowEmpty = false): string[] {
  const values = Array.isArray(value) ? value.map((item) => asText(item,20)).filter((item) => (TIER_KEYS as readonly string[]).includes(item)) : [];
  const unique = [...new Set(values)];
  if (!allowEmpty && !unique.length) throw new ApiError(400,"INVALID_TIER_ACCESS","至少選擇一個會員等級。");
  return unique;
}

type BookingServiceOption = { serviceId: string; title: string; serviceType: string; isActive: boolean };

async function bookingServiceOptions(supabase: SupabaseClient): Promise<BookingServiceOption[]> {
  const result = await supabase.from("booking_services")
    .select("id,title,service_type,is_active")
    .is("deleted_at",null)
    .order("created_at",{ ascending:true });
  if (result.error) throw mapDatabaseError(result.error);
  return (result.data || []).map((row:any) => ({
    serviceId: asText(row.id,80),
    title: asText(row.title,120),
    serviceType: asText(row.service_type,80),
    isActive: row.is_active !== false,
  })).filter((service) => service.serviceId && service.title);
}

async function bookingServiceTypeNames(supabase: SupabaseClient): Promise<string[]> {
  const services = await bookingServiceOptions(supabase);
  return [...new Set(services.map((service) => service.serviceType).filter(Boolean))];
}

async function normalizeRequiredServiceIds(supabase: SupabaseClient, value: unknown): Promise<string[]> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400,"INVALID_REQUIRED_SERVICE_IDS","預約項目限制最多可選 20 個項目。");
  }
  const requested = [...new Set(value.map((item) => asText(item,80)).filter(Boolean))];
  if (!requested.length) return [];
  const allowed = await bookingServiceOptions(supabase);
  const allowedIds = new Set(allowed.map((service) => service.serviceId));
  if (requested.some((serviceId) => !allowedIds.has(serviceId))) {
    throw new ApiError(400,"INVALID_REQUIRED_SERVICE_IDS","票券指定的預約項目已不存在，請重新選擇。");
  }
  return requested;
}


async function normalizeRequiredServiceGroups(supabase: SupabaseClient, value: unknown): Promise<string[][]> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw new ApiError(400, "INVALID_REQUIRED_SERVICE_GROUPS", "最多可設定 10 組替代預約組合。");
  }
  if (!value.length) return [];
  let count = 0;
  const groups = value.map((group: unknown) => {
    if (!Array.isArray(group) || group.length < 1 || group.length > 20) {
      throw new ApiError(400, "INVALID_REQUIRED_SERVICE_GROUPS", "每組必須選擇 1–20 個預約項目。");
    }
    const ids = group.map((id: unknown) => asText(id, 80)).filter(Boolean);
    if (ids.length !== group.length || new Set(ids).size !== ids.length) {
      throw new ApiError(400, "INVALID_REQUIRED_SERVICE_GROUPS", "同一組不可重複或留空預約項目。");
    }
    count += ids.length;
    return ids;
  });
  if (count > 40) {
    throw new ApiError(400, "INVALID_REQUIRED_SERVICE_GROUPS", "所有組合最多共可設定 40 個預約項目。");
  }
  const allowed = new Set((await bookingServiceOptions(supabase)).map(service => service.serviceId));
  if (groups.some(group => group.some(id => !allowed.has(id)))) {
    throw new ApiError(400, "INVALID_REQUIRED_SERVICE_GROUPS", "預約組合包含已刪除的項目，請重新選擇。");
  }
  return groups;
}

async function serviceIdsForLegacyTypes(supabase: SupabaseClient, value: unknown): Promise<string[]> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400,"INVALID_REQUIRED_SERVICE_TYPES","預約項目限制最多可選 20 種舊項目類型。");
  }
  const requested = new Set(value.map((item) => asText(item,80).toLocaleLowerCase("zh-Hant-TW")).filter(Boolean));
  if (!requested.size) return [];
  const services = await bookingServiceOptions(supabase);
  return services
    .filter((service) => requested.has(service.serviceType.toLocaleLowerCase("zh-Hant-TW")))
    .map((service) => service.serviceId);
}

function normalizePrizes(value: unknown, required: boolean): Array<{ prizeTitle: string; prizeDescription: string; winRate: number }> {
  if (!required) return [];
  if (!Array.isArray(value) || !value.length) throw new ApiError(400,"INVALID_PRIZES","抽獎券至少需要一個獎項。");
  const prizes = value.map((raw) => {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const prizeTitle = requireText(item.prizeTitle,"獎項名稱",100);
    const prizeDescription = asText(item.prizeDescription,500);
    const winRate = Number(item.winRate);
    if (!Number.isFinite(winRate) || winRate < 0 || winRate > 100) throw new ApiError(400,"INVALID_PRIZES","獎項機率必須介於 0–100%。");
    return { prizeTitle, prizeDescription, winRate: Number(winRate.toFixed(4)) };
  });
  const total = prizes.reduce((sum,item) => sum + item.winRate,0);
  if (Math.abs(total - 100) > 0.001) throw new ApiError(400,"INVALID_PRIZES","抽獎獎項機率合計必須為 100%。");
  return prizes;
}


function normalizeTicketLocations(value: unknown, requiresLocation: boolean): Array<{ name: string; latitude: number; longitude: number; radiusMeters: number }> {
  if (!requiresLocation) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new ApiError(400,"INVALID_LOCATION_RULE","請設定 1–20 個核銷地點。");
  }
  const locations = value.map((raw) => {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const name = asText(item.name,100);
    const latitude = item.latitude === "" || item.latitude == null ? NaN : Number(item.latitude);
    const longitude = item.longitude === "" || item.longitude == null ? NaN : Number(item.longitude);
    const radiusMeters = item.radiusMeters === "" || item.radiusMeters == null ? NaN : Number(item.radiusMeters);
    if (!name || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isInteger(radiusMeters) || radiusMeters < 50 || radiusMeters > 2000) {
      throw new ApiError(400,"INVALID_LOCATION_RULE","每個地點需有名稱、有效座標與 50–2000 公尺半徑。");
    }
    return { name, latitude, longitude, radiusMeters };
  });
  return locations;
}

async function consumeRateLimit(supabase: SupabaseClient, principal: string, action: string, body: Json): Promise<void> {
  const cost = action === "admin.calendar-items.batch" && Array.isArray(body.calendarItemOperations)
    ? Math.max(1,Math.min(20,body.calendarItemOperations.length)) : 1;
  const { data, error } = await supabase.rpc("consume_api_rate_limit",{
    p_principal_hash: await sha256(principal),
    p_is_write: WRITE_ACTIONS.has(action),
    p_cost: cost,
    p_read_limit: READ_LIMIT,
    p_write_limit: WRITE_LIMIT,
  });
  if (error) throw new ApiError(503,"RATE_LIMIT_UNAVAILABLE","無法確認請求頻率限制。");
  if (!data) throw new ApiError(429,"RATE_LIMITED","請求過於密集，請稍後再試。");
}

async function ensureMember(supabase: SupabaseClient, identity: { lineUserId: string; displayName: string }): Promise<any> {
  let { data: member, error } = await supabase.from("members").select("*").eq("line_user_id",identity.lineUserId).maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!member) {
    const memberCode = "M" + crypto.randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
    const inserted = await supabase.from("members").insert({
      line_user_id: identity.lineUserId,
      display_name: identity.displayName,
      member_code: memberCode,
      last_login_at: new Date().toISOString(),
    }).select("*").single();
    if (inserted.error) {
      const retry = await supabase.from("members").select("*").eq("line_user_id",identity.lineUserId).single();
      if (retry.error) throw mapDatabaseError(inserted.error);
      member = retry.data;
    } else member = inserted.data;
  } else {
    const patch: Json = { last_login_at: new Date().toISOString() };
    if (identity.displayName && identity.displayName !== member.display_name) patch.display_name = identity.displayName;
    const updated = await supabase.from("members").update(patch).eq("id",member.id).select("*").single();
    if (!updated.error) member = updated.data;
  }
  return member;
}

async function requireJoinedMember(supabase: SupabaseClient, identity: { lineUserId: string; displayName: string }): Promise<any> {
  const member = await ensureMember(supabase,identity);
  if (member.membership_status !== "active") throw new ApiError(403,"MEMBERSHIP_REQUIRED","請先完成會員加入後再使用此功能。");
  if (member.status !== "active") throw new ApiError(403,"MEMBER_DISABLED","此會員目前已停用。");
  if (!(await hasCurrentTermsConsent(supabase, member.id))) throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先至會員卡同意新版條款。");
  return member;
}

async function tierSettings(supabase: SupabaseClient): Promise<any[]> {
  const { data, error } = await supabase.from("membership_tier_settings").select("*").order("required_service_minutes",{ ascending: true });
  if (error) throw mapDatabaseError(error);
  return data || [];
}

function tierSettingsClient(rows: any[]): any[] {
  return rows.map((row) => ({
    tierKey: row.tier_key,
    label: row.tier_label,
    requiredServiceMinutes: Number(row.required_service_minutes || 0),
    styleKey: row.style_key || "forest",
    updatedAt: row.updated_at,
  }));
}

async function serviceMinutesForMembers(supabase: SupabaseClient, memberIds: string[]): Promise<Map<string,number>> {
  const result = new Map<string,number>(memberIds.map((id) => [id,0]));
  if (!memberIds.length) return result;
  const { data, error } = await supabase.rpc("member_service_minute_totals", { p_member_ids: memberIds });
  if (error) throw mapDatabaseError(error);
  for (const row of data || []) result.set(row.member_id,Number(row.total_minutes || 0));
  return result;
}

function tierForMinutes(settings: any[], minutes: number): any {
  let current = settings[0] || { tier_key:"general",tier_label:"一般會員",required_service_minutes:0,style_key:"forest" };
  for (const row of settings) if (Number(row.required_service_minutes) <= minutes) current = row;
  return current;
}

function profileFrom(member: any, settings: any[], serviceMinutesTotal: number): Json {
  const current = tierForMinutes(settings,serviceMinutesTotal);
  const index = Math.max(0,settings.findIndex((row) => row.tier_key === current.tier_key));
  const next = settings[index + 1] || null;
  const surname = asText(member.surname,40);
  const salutation = asText(member.salutation,10).toLowerCase();
  return {
    lineUserId: member.line_user_id,
    displayName: member.display_name || "LINE 使用者",
    memberCode: member.member_code,
    status: member.status,
    joinedAt: member.joined_at || member.created_at,
    birthday: member.birthday || "",
    phone: member.phone || "",
    surname,
    salutation,
    salutationLabel: salutation === "mr" ? "先生" : salutation === "ms" ? "小姐" : "",
    profileComplete: member.membership_status === "active" && Boolean(member.birthday && member.phone && surname && ["mr","ms"].includes(salutation)),
    membershipRequired: member.membership_status !== "active",
    serviceMinutesTotal,
    tierKey: current.tier_key,
    tier: current.tier_label,
    tierStyleKey: current.style_key || "forest",
    tierProgress: {
      serviceMinutesTotal,
      currentRequiredServiceMinutes: Number(current.required_service_minutes || 0),
      nextTierKey: next?.tier_key || "",
      nextTierLabel: next?.tier_label || "",
      nextRequiredServiceMinutes: next ? Number(next.required_service_minutes || 0) : null,
      remainingServiceMinutes: next ? Math.max(0,Number(next.required_service_minutes || 0) - serviceMinutesTotal) : 0,
      isHighestTier: !next && current.tier_key === TIER_KEYS[TIER_KEYS.length - 1],
    },
  };
}

async function profileFor(supabase: SupabaseClient, member: any): Promise<Json> {
  const [settings,totals] = await Promise.all([
    tierSettings(supabase),
    serviceMinutesForMembers(supabase,[member.id]),
  ]);
  return profileFrom(member,settings,totals.get(member.id) || 0);
}

async function authorizeAdmin(supabase: SupabaseClient, identity: { lineUserId: string; displayName: string }): Promise<any> {
  return await requireActiveAdminContract({
    supabase,
    identity,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function membersPage(supabase: SupabaseClient, page = 1, pageSize = 100, query = "", memberKind = "real", sharedSettings?: Promise<any[]>): Promise<{ members: any[]; memberPage: Json }> {
  const safePageSize = Math.max(1,Math.min(100,Math.floor(Number(pageSize) || 100)));
  const safePage = Math.max(1,Math.floor(Number(page) || 1));
  const normalizedQuery = asText(query,100).toLowerCase();
  const isTestAccount = asText(memberKind,10).toLowerCase() === "test";
  if (isTestAccount) throw new ApiError(410,"TEST_MEMBERS_RETIRED","測試會員功能已移除。");
  let q = supabase.from("members").select("*",{ count:"exact" }).eq("is_test_account",isTestAccount);
  if (normalizedQuery) q = q.or(`display_name.ilike.%${normalizedQuery.replaceAll(",","")}%,member_code.ilike.%${normalizedQuery.replaceAll(",","")}%`);
  const start = (safePage - 1) * safePageSize;
  const [{ data, count, error },settings] = await Promise.all([
    q.order("created_at",{ ascending:false }).range(start,start + safePageSize - 1),
    sharedSettings || tierSettings(supabase),
  ]);
  if (error) throw mapDatabaseError(error);
  const rows = data || [];
  const memberIds = rows.map((row) => row.id);
  const presenceCutoff = new Date(Date.now() - PRESENCE_ONLINE_WINDOW_MS).toISOString();
  const [totals,presenceResult] = await Promise.all([
    serviceMinutesForMembers(supabase,memberIds),
    memberIds.length
      ? supabase.from("member_presence_sessions")
          .select("member_id,surface,last_seen_at")
          .in("member_id",memberIds)
          .is("offline_at",null)
          .gte("last_seen_at",presenceCutoff)
          .order("last_seen_at",{ ascending:false })
      : Promise.resolve({ data:[],error:null }),
  ]);
  if (presenceResult.error) throw mapDatabaseError(presenceResult.error);
  const presenceByMember = new Map<string,{ lastSeenAt:string;surfaces:Set<string> }>();
  for (const row of presenceResult.data || []) {
    const current = presenceByMember.get(row.member_id) || { lastSeenAt:"",surfaces:new Set<string>() };
    if (!current.lastSeenAt || String(row.last_seen_at) > current.lastSeenAt) current.lastSeenAt = String(row.last_seen_at || "");
    if (row.surface) current.surfaces.add(String(row.surface));
    presenceByMember.set(row.member_id,current);
  }
  const members = rows.map((member) => {
    const minutes = totals.get(member.id) || 0;
    const tier = tierForMinutes(settings,minutes);
    const presence = presenceByMember.get(member.id);
    return {
      lineUserId: member.line_user_id,
      displayName: member.display_name,
      memberCode: member.member_code,
      status: member.status,
      membershipStatus: member.membership_status,
      birthday: member.birthday || "",
      phone: member.phone || "",
      surname: member.surname || "",
      salutation: member.salutation || "",
      isTestAccount: member.is_test_account === true,
      testAccountSequence: member.test_account_sequence || null,
      joinedAt: member.joined_at || member.created_at,
      serviceMinutesTotal: minutes,
      tierKey: tier.tier_key,
      tier: tier.tier_label,
      tierStyleKey: tier.style_key,
      isOnline:Boolean(presence),
      lastSeenAt:presence?.lastSeenAt || "",
      onlineSurfaces:presence ? [...presence.surfaces] : [],
      updatedAt: member.updated_at,
    };
  });
  const total = Number(count || 0);
  const totalPages = Math.max(1,Math.ceil(total / safePageSize));
  return { members, memberPage: { page: Math.min(safePage,totalPages), pageSize: safePageSize, total, totalPages, query: normalizedQuery, memberKind: isTestAccount ? "test" : "real" } };
}

async function memberPresenceForLineUserIds(supabase: SupabaseClient, lineUserIds: string[]): Promise<Json> {
  const normalized = [...new Set(lineUserIds.map((value) => asText(value,120)).filter(Boolean))];
  if (normalized.length > 100) throw new ApiError(400,"INVALID_MEMBER_PRESENCE_REQUEST","一次最多查詢 100 位會員上線狀態。");
  if (!normalized.length) return { members:[],onlineWindowMs:PRESENCE_ONLINE_WINDOW_MS };

  const membersResult = await supabase.from("members")
    .select("id,line_user_id")
    .in("line_user_id",normalized);
  if (membersResult.error) throw mapDatabaseError(membersResult.error);
  const memberRows = membersResult.data || [];
  const memberIds = memberRows.map((row:any) => row.id);
  const cutoff = new Date(Date.now() - PRESENCE_ONLINE_WINDOW_MS).toISOString();
  const presenceResult = memberIds.length
    ? await supabase.from("member_presence_sessions")
        .select("member_id,surface,last_seen_at")
        .in("member_id",memberIds)
        .is("offline_at",null)
        .gte("last_seen_at",cutoff)
        .order("last_seen_at",{ ascending:false })
    : { data:[],error:null };
  if (presenceResult.error) throw mapDatabaseError(presenceResult.error);

  const stateByMember = new Map<string,{lastSeenAt:string;surfaces:Set<string>}>();
  for (const row of presenceResult.data || []) {
    const current = stateByMember.get(row.member_id) || { lastSeenAt:"",surfaces:new Set<string>() };
    if (!current.lastSeenAt || String(row.last_seen_at) > current.lastSeenAt) current.lastSeenAt = String(row.last_seen_at || "");
    if (row.surface) current.surfaces.add(String(row.surface));
    stateByMember.set(row.member_id,current);
  }
  return {
    members:memberRows.map((row:any) => {
      const current = stateByMember.get(row.id);
      return {
        lineUserId:row.line_user_id,
        isOnline:Boolean(current),
        lastSeenAt:current?.lastSeenAt || "",
        onlineSurfaces:current ? [...current.surfaces] : [],
      };
    }),
    onlineWindowMs:PRESENCE_ONLINE_WINDOW_MS,
  };
}


async function adminMemberRecords(supabase: SupabaseClient, lineUserId: string): Promise<Json> {
  const memberResult = await supabase.from("members")
    .select("id,line_user_id,display_name,member_code,is_test_account")
    .eq("line_user_id",lineUserId)
    .maybeSingle();
  if (memberResult.error) throw mapDatabaseError(memberResult.error);
  if (!memberResult.data) throw new ApiError(404,"MEMBER_NOT_FOUND","找不到指定會員。");
  const member = memberResult.data;

  const [pointEntriesRes,pointTicketsRes,eventClaimsRes,bookingsRes,settlementsRes,presenceRes,automationCasesRes] = await Promise.all([
    supabase.from("point_entries").select("id,entry_id,point_card_id,amount,note,entry_type,reference_type,reference_id,created_at").eq("member_id",member.id).order("created_at",{ ascending:false }),
    supabase.from("point_tickets").select("id,ticket_id,point_card_id,ticket_type,ticket_title,status,earned_at,used_at,result,points_spent,created_at,updated_at").eq("member_id",member.id).order("created_at",{ ascending:false }),
    supabase.from("event_ticket_claims").select("id,claim_id,event_ticket_id,ticket_type,ticket_title,status,claimed_at,used_at,result,created_at,updated_at").eq("member_id",member.id).order("created_at",{ ascending:false }),
    supabase.from("bookings").select("id,request_id,service_id,technician_id,booking_date,start_time,end_time,start_at,end_at,status,member_note,total_duration_minutes,party_size,confirmed_at,rejected_at,cancelled_at,completed_at,cancellation_requested_at,cancellation_reviewed_at,cancellation_decision,created_at,updated_at").eq("member_id",member.id).order("booking_date",{ ascending:false }).order("start_time",{ ascending:false }),
    supabase.from("booking_completion_settlements").select("booking_id,service_minutes,reward_details,created_at").eq("member_id",member.id).order("created_at",{ ascending:false }),
    supabase.from("audit_logs").select("id,audit_id,action,detail,created_at").eq("target_type","member").eq("target_id",member.line_user_id).in("action",[...PRESENCE_ACTIONS]).order("created_at",{ ascending:false }),
    supabase.from("automation_test_cases").select("id,run_id,case_order,case_key,name,domain,status,failure_code,failure_message,started_at,completed_at,duration_ms,created_at,updated_at").eq("member_id",member.id).order("created_at",{ ascending:false }).limit(100),
  ]);
  for (const result of [pointEntriesRes,pointTicketsRes,eventClaimsRes,bookingsRes,settlementsRes,presenceRes,automationCasesRes]) {
    if (result.error) throw mapDatabaseError(result.error);
  }

  const pointEntries = pointEntriesRes.data || [];
  const pointTickets = pointTicketsRes.data || [];
  const eventClaims = eventClaimsRes.data || [];
  const bookings = bookingsRes.data || [];
  const settlements = settlementsRes.data || [];
  const presenceEvents = presenceRes.data || [];
  const automationCases = automationCasesRes.data || [];
  const automationCaseIds = automationCases.map((row:any) => row.id).filter(Boolean);
  const automationRunIds = [...new Set(automationCases.map((row:any) => row.run_id).filter(Boolean))];

  const pointCardIds = [...new Set([...pointEntries,...pointTickets].map((row:any) => row.point_card_id).filter(Boolean))];
  const eventTicketIds = [...new Set(eventClaims.map((row:any) => row.event_ticket_id).filter(Boolean))];
  const bookingIds = bookings.map((row:any) => row.id).filter(Boolean);
  const serviceIds = [...new Set(bookings.map((row:any) => row.service_id).filter(Boolean))];

  const [cardsRes,calendarRes,servicesRes,participantsRes,automationRunsRes,automationStepsRes] = await Promise.all([
    pointCardIds.length
      ? supabase.from("point_cards").select("id,card_id,title").in("id",pointCardIds)
      : Promise.resolve({ data:[],error:null }),
    eventTicketIds.length
      ? supabase.from("calendar_items").select("calendar_item_id,title,item_type,starts_on,ends_on,status,source_event_ticket_id,created_at,updated_at").in("source_event_ticket_id",eventTicketIds).order("starts_on",{ ascending:false })
      : Promise.resolve({ data:[],error:null }),
    serviceIds.length
      ? supabase.from("booking_services").select("id,title").in("id",serviceIds)
      : Promise.resolve({ data:[],error:null }),
    bookingIds.length
      ? supabase.from("booking_participants").select("id,booking_id,position,technician_id").in("booking_id",bookingIds).order("position",{ ascending:true })
      : Promise.resolve({ data:[],error:null }),
    automationRunIds.length
      ? supabase.from("automation_test_runs").select("id,run_code,suite,status,summary,triggered_by,started_at,completed_at,created_at").in("id",automationRunIds)
      : Promise.resolve({ data:[],error:null }),
    automationCaseIds.length
      ? supabase.from("automation_test_steps").select("id,case_id,step_order,step_key,name,status,expected,actual,message,started_at,completed_at,duration_ms,created_at").in("case_id",automationCaseIds).order("step_order",{ ascending:true })
      : Promise.resolve({ data:[],error:null }),
  ]);
  for (const result of [cardsRes,calendarRes,servicesRes,participantsRes,automationRunsRes,automationStepsRes]) {
    if (result.error) throw mapDatabaseError(result.error);
  }

  const participants = participantsRes.data || [];
  const participantIds = participants.map((row:any) => row.id).filter(Boolean);
  const technicianIds = [...new Set([
    ...bookings.map((row:any) => row.technician_id),
    ...participants.map((row:any) => row.technician_id),
  ].filter(Boolean))];

  const [participantItemsRes,techniciansRes] = await Promise.all([
    participantIds.length
      ? supabase.from("booking_participant_items").select("participant_id,service_title,unit_duration_minutes,unit_price_amount,quantity").in("participant_id",participantIds)
      : Promise.resolve({ data:[],error:null }),
    technicianIds.length
      ? supabase.from("booking_technicians").select("id,name").in("id",technicianIds)
      : Promise.resolve({ data:[],error:null }),
  ]);
  for (const result of [participantItemsRes,techniciansRes]) {
    if (result.error) throw mapDatabaseError(result.error);
  }

  const cardById = new Map((cardsRes.data || []).map((row:any) => [row.id,row]));
  const serviceById = new Map((servicesRes.data || []).map((row:any) => [row.id,row]));
  const technicianById = new Map((techniciansRes.data || []).map((row:any) => [row.id,row.name]));
  const settlementByBooking = new Map(settlements.map((row:any) => [row.booking_id,row]));
  const automationRunById = new Map((automationRunsRes.data || []).map((row:any) => [row.id,row]));
  const automationStepsByCase = new Map<string,any[]>();
  for (const step of automationStepsRes.data || []) {
    const rows = automationStepsByCase.get(step.case_id) || [];
    rows.push(step);
    automationStepsByCase.set(step.case_id,rows);
  }
  const itemsByParticipant = new Map<string,any[]>();
  for (const item of participantItemsRes.data || []) {
    const items = itemsByParticipant.get(item.participant_id) || [];
    items.push(item);
    itemsByParticipant.set(item.participant_id,items);
  }
  const participantsByBooking = new Map<string,any[]>();
  for (const participant of participants) {
    const rows = participantsByBooking.get(participant.booking_id) || [];
    rows.push({
      position:Number(participant.position || 0),
      technicianName:technicianById.get(participant.technician_id) || "",
      items:(itemsByParticipant.get(participant.id) || []).map((item:any) => ({
        title:item.service_title || "預約項目",
        durationMinutes:Number(item.unit_duration_minutes || 0),
        priceAmount:Number(item.unit_price_amount || 0),
        quantity:Number(item.quantity || 1),
      })),
    });
    participantsByBooking.set(participant.booking_id,rows);
  }

  const pointRecords = [
    ...pointEntries.map((row:any) => {
      const card = cardById.get(row.point_card_id);
      return {
        recordId:`point-entry:${row.id}`,
        recordType:"point_entry",
        title:card?.title || "集點卡",
        cardId:card?.card_id || "",
        amount:Number(row.amount || 0),
        entryType:row.entry_type || "",
        note:row.note || "",
        referenceType:row.reference_type || "",
        referenceId:row.reference_id || "",
        occurredAt:row.created_at,
      };
    }),
    ...pointTickets.map((row:any) => {
      const card = cardById.get(row.point_card_id);
      return {
        recordId:`point-ticket:${row.id}`,
        recordType:"point_ticket",
        title:row.ticket_title || "集點卡票券",
        cardTitle:card?.title || "",
        ticketType:row.ticket_type || "",
        status:row.status || "",
        pointsSpent:Number(row.points_spent || 0),
        earnedAt:row.earned_at || row.created_at,
        usedAt:row.used_at || "",
        result:row.result || null,
        occurredAt:row.used_at || row.earned_at || row.updated_at || row.created_at,
      };
    }),
  ].sort((a:any,b:any) => String(b.occurredAt || "").localeCompare(String(a.occurredAt || "")));

  const eventTicketRecords = eventClaims.map((row:any) => ({
    recordId:`event-ticket:${row.id}`,
    claimId:row.claim_id,
    eventTicketId:row.event_ticket_id,
    title:row.ticket_title || "活動票券",
    ticketType:row.ticket_type || "",
    status:row.status || "",
    claimedAt:row.claimed_at || row.created_at,
    usedAt:row.used_at || "",
    result:row.result || null,
    occurredAt:row.used_at || row.claimed_at || row.updated_at || row.created_at,
  }));

  const claimByEventTicket = new Map(eventTicketRecords.map((row:any) => [row.eventTicketId,row]));
  const calendarRecords = (calendarRes.data || []).map((row:any) => {
    const claim:any = claimByEventTicket.get(row.source_event_ticket_id);
    return {
      recordId:`calendar:${row.calendar_item_id}`,
      calendarItemId:row.calendar_item_id,
      title:row.title || "日曆項目",
      itemType:row.item_type || "",
      status:row.status || "",
      startsOn:row.starts_on || "",
      endsOn:row.ends_on || "",
      relatedTicketTitle:claim?.title || "",
      relatedTicketStatus:claim?.status || "",
      relatedClaimId:claim?.claimId || "",
      occurredAt:row.starts_on || row.created_at,
    };
  });

  const presenceRecords = presenceEvents.map((row:any) => {
    const info = presenceActionInfo(String(row.action || ""));
    const detail = row.detail && typeof row.detail === "object" ? row.detail as Json : {};
    return {
      recordId:`presence:${row.id}`,
      event:info?.event || "",
      surface:info?.surface || asText(detail.surface,20),
      reason:asText(detail.reason,30),
      sessionId:asText(detail.sessionId,80),
      occurredAt:row.created_at,
    };
  });

  const automationRecords = automationCases.map((row:any) => {
    const run:any = automationRunById.get(row.run_id) || {};
    const steps = (automationStepsByCase.get(row.id) || []).map((step:any) => ({
      stepKey:step.step_key || "",
      name:step.name || "",
      status:step.status || "",
      expected:step.expected ?? {},
      actual:step.actual ?? {},
      message:step.message || "",
      durationMs:Number(step.duration_ms || 0),
    }));
    const primaryStep:any = steps[steps.length - 1] || {};
    return {
      recordId:`automation-test:${row.id}`,
      runId:row.run_id,
      runCode:run.run_code || "",
      suite:run.suite || "",
      runStatus:run.status || "",
      source:run.summary && typeof run.summary === "object" ? asText((run.summary as Json).source,40) : "",
      surface:run.summary && typeof run.summary === "object" ? asText((run.summary as Json).surface,20) : "",
      caseKey:row.case_key || "",
      title:row.name || "自動化測試",
      domain:row.domain || "",
      status:row.status || "",
      failureCode:row.failure_code || "",
      failureMessage:row.failure_message || "",
      message:primaryStep.message || row.failure_message || "",
      expected:primaryStep.expected ?? {},
      actual:primaryStep.actual ?? {},
      steps,
      durationMs:Number(row.duration_ms || 0),
      occurredAt:row.completed_at || row.updated_at || row.created_at,
    };
  });

  const bookingRecords = bookings.map((row:any) => {
    const settlement = settlementByBooking.get(row.id);
    return {
      recordId:`booking:${row.id}`,
      bookingId:row.id,
      requestId:row.request_id || "",
      title:serviceById.get(row.service_id)?.title || "預約",
      technicianName:technicianById.get(row.technician_id) || "",
      bookingDate:row.booking_date || "",
      startAt:row.start_at || "",
      endAt:row.end_at || "",
      startTime:row.start_time || "",
      endTime:row.end_time || "",
      status:row.status || "",
      memberNote:row.member_note || "",
      totalDurationMinutes:Number(row.total_duration_minutes || 0),
      partySize:Number(row.party_size || 1),
      participants:participantsByBooking.get(row.id) || [],
      confirmedAt:row.confirmed_at || "",
      rejectedAt:row.rejected_at || "",
      cancelledAt:row.cancelled_at || "",
      completedAt:row.completed_at || "",
      cancellationRequestedAt:row.cancellation_requested_at || "",
      cancellationReviewedAt:row.cancellation_reviewed_at || "",
      cancellationDecision:row.cancellation_decision || "",
      settlement:settlement ? {
        serviceMinutes:Number(settlement.service_minutes || 0),
        rewardDetails:settlement.reward_details || null,
        createdAt:settlement.created_at || "",
      } : null,
      createdAt:row.created_at,
      occurredAt:row.completed_at || row.cancelled_at || row.rejected_at || row.confirmed_at || row.updated_at || row.created_at,
    };
  });

  return {
    member:{
      lineUserId:member.line_user_id,
      displayName:member.display_name,
      memberCode:member.member_code,
    },
    records:{
      pointCards:pointRecords,
      eventTickets:eventTicketRecords,
      calendar:calendarRecords,
      bookings:bookingRecords,
      presence:presenceRecords,
      testAutomation:automationRecords,
    },
    counts:{
      pointCards:pointRecords.length,
      eventTickets:eventTicketRecords.length,
      calendar:calendarRecords.length,
      bookings:bookingRecords.length,
      presence:presenceRecords.length,
      testAutomation:automationRecords.length,
    },
    calendarTracking:"linked_records_only",
  };
}

function isExpiredCard(row: any): boolean {
  if (row.expiry_mode !== "date" || !row.expires_on) return false;
  return String(row.expires_on) < taipeiDate();
}

function taipeiDate(): string {
  const parts: Record<string,string> = {};
  new Intl.DateTimeFormat("en-CA",{ timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit" })
    .formatToParts(new Date()).forEach((part) => { if (part.type !== "literal") parts[part.type] = part.value; });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function mapTicketTemplate(row: any): Json {
  return {
    ticketTemplateId: row.ticket_template_id,
    title: row.title,
    ticketType: row.ticket_type,
    description: row.description || "",
    usageMethod: row.usage_method || "",
    usageInstructions: row.usage_instructions || "",
    prizes: Array.isArray(row.prizes) ? row.prizes : [],
    status: row.status,
    requiresLocation: Boolean(row.requires_location),
    redemptionLocations: Array.isArray(row.redemption_locations) ? row.redemption_locations : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function adminCards(supabase: SupabaseClient): Promise<{ cards: any[]; tickets: any[] }> {
  const [cardsRes,rewardsRes,templatesRes] = await Promise.all([
    supabase.from("point_cards").select("*").order("sort_order",{ ascending:true }).order("created_at",{ ascending:true }),
    supabase.from("point_card_rewards").select("*").order("threshold_stamps",{ ascending:true }),
    supabase.from("ticket_templates").select("*").order("created_at",{ ascending:false }),
  ]);
  if (cardsRes.error) throw mapDatabaseError(cardsRes.error);
  if (rewardsRes.error) throw mapDatabaseError(rewardsRes.error);
  if (templatesRes.error) throw mapDatabaseError(templatesRes.error);
  const templateById = new Map((templatesRes.data || []).map((row:any) => [row.id,row]));
  const rewardsByCard = new Map<string,any[]>();
  for (const reward of rewardsRes.data || []) {
    const template = templateById.get(reward.ticket_template_id);
    if (!template) continue;
    const list = rewardsByCard.get(reward.point_card_id) || [];
    list.push({
      rewardId: reward.reward_id,
      rewardDbId: reward.id,
      thresholdStamps: Number(reward.threshold_stamps),
      ticketTemplateId: template.ticket_template_id,
      ticketTemplateDbId: template.id,
      rewardType: template.ticket_type,
      rewardTitle: template.title,
      rewardDescription: template.description || "",
      usageMethod: template.usage_method || "",
      usageInstructions: template.usage_instructions || "",
      prizes: Array.isArray(template.prizes) ? template.prizes : [],
      requiredServiceIds: Array.isArray(reward.required_service_ids) ? reward.required_service_ids : [],
      requiredServiceMatchMode: Array.isArray(reward.required_service_groups) && reward.required_service_groups.length ? "groups" : reward.required_service_match_mode === "all" ? "all" : "any",
       requiredServiceGroups: Array.isArray(reward.required_service_groups) ? reward.required_service_groups : [],
      requiredServiceTypes: [],
      updatedAt: reward.updated_at,
    });
    rewardsByCard.set(reward.point_card_id,list);
  }
  return {
    cards: (cardsRes.data || []).map((row:any) => ({
      cardId: row.card_id,
      title: row.title,
      description: row.description || "",
      status: row.status,
      accent: row.accent,
      styleKey: row.style_key,
      expiryMode: row.expiry_mode,
      expiresOn: row.expires_on || "",
      sortOrder: Number(row.sort_order || 0),
      usageMethod: row.usage_method || "",
      usageInstructions: row.usage_instructions || "",
      benefitDescription: row.benefit_description || "",
      expired: isExpiredCard(row),
      rewards: rewardsByCard.get(row.id) || [],
      rewardCount: (rewardsByCard.get(row.id) || []).length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    tickets: (templatesRes.data || []).map(mapTicketTemplate),
  };
}

function pointTicketClient(row: any, cardId = "", reservedForBooking = false): Json {
  return {
    ticketId: row.ticket_id,
    cardId: cardId || row.card_id || "",
    rewardId: row.reward_id || "",
    ticketTemplateId: row.ticket_template_id || "",
    thresholdStamps: Number(row.threshold_stamps || 0),
    ticketType: row.ticket_type,
    ticketTitle: row.ticket_title,
    ticketDescription: row.ticket_description || "",
    usageMethod: row.usage_method || "",
    usageInstructions: row.usage_instructions || "",
    prizes: Array.isArray(row.prizes) ? row.prizes : [],
    status: row.status,
    reservedForBooking: Boolean(reservedForBooking),
    requiresLocation: Boolean(row.requires_location),
    redemptionLocations: Boolean(row.requires_location) && Array.isArray(row.redemption_locations) ? row.redemption_locations : [],
    earnedAt: row.earned_at,
    usedAt: row.used_at || "",
    result: row.result || null,
    pointsSpent: Number(row.points_spent || 0),
  };
}

async function pointBootstrap(supabase: SupabaseClient, member: any): Promise<Json> {
  const [profile,{ cards: adminCardRows },bookingSelections,snapshotReceipts] = await Promise.all([
    profileFor(supabase,member),
    adminCards(supabase),
    loadMemberBookingSelections(supabase, String(member.id)),
    supabase.from("booking_receipts")
      .select("receipt_id,created_at,updated_at,requested_benefits")
      .eq("member_id",member.id).eq("submission_mode","accessible")
      .eq("status","awaiting_review").order("created_at",{ascending:false}).limit(100),
  ]);
  if (snapshotReceipts.error) throw mapDatabaseError(snapshotReceipts.error);
  const snapshotByPointTicket = new Map<string,Json[]>();
  for (const receipt of snapshotReceipts.data || []) {
    for (const benefit of Array.isArray(receipt.requested_benefits) ? receipt.requested_benefits : []) {
      if (benefit?.kind !== "points" || !benefit.id) continue;
      const ref = String(benefit.id);
      const snapshots = snapshotByPointTicket.get(ref) || [];
      if (!snapshots.some(item => item.receiptId === String(receipt.receipt_id)))
        snapshots.push({ receiptId:String(receipt.receipt_id),createdAt:String(receipt.created_at),updatedAt:String(receipt.updated_at) });
      snapshotByPointTicket.set(ref,snapshots);
    }
  }
  const activeCards = adminCardRows.filter((card:any) => card.status === "active");
  const rawCards = activeCards.length
    ? await supabase.from("point_cards").select("id,card_id").in("card_id",activeCards.map((card:any) => card.cardId))
    : { data:[], error:null };
  if (rawCards.error) throw mapDatabaseError(rawCards.error);
  const idByCard = new Map((rawCards.data || []).map((row:any) => [row.card_id,row.id]));
  const pointCardIds = [...idByCard.values()];
  if (pointCardIds.length) {
    const issued = await supabase.rpc("issue_eligible_point_tickets_for_member", {
      p_member_id: member.id,
      p_point_card_ids: pointCardIds,
    });
    if (issued.error) throw mapDatabaseError(issued.error);
  }
  // Resolve booking/direct-use eligibility only after newly earned tickets exist.
  const bookingOptions = await supabase.rpc("member_ticket_booking_options", { p_member_id: member.id });
  if (bookingOptions.error) throw mapDatabaseError(bookingOptions.error);
  const [balancesRes,ticketsRes,pendingSelectionsRes] = pointCardIds.length
    ? await Promise.all([
      supabase.from("point_balances").select("*").eq("member_id",member.id).in("point_card_id",pointCardIds),
      supabase.from("point_tickets").select("*").eq("member_id",member.id).in("point_card_id",pointCardIds).order("created_at",{ ascending:false }),
      supabase.from("booking_benefit_selections").select("benefit_ref")
        .eq("member_id",member.id).eq("benefit_kind","points").eq("status","pending"),
    ])
    : [{ data:[], error:null },{ data:[], error:null },{ data:[], error:null }];
  if (balancesRes.error) throw mapDatabaseError(balancesRes.error);
  if (ticketsRes.error) throw mapDatabaseError(ticketsRes.error);
  if (pendingSelectionsRes.error) throw mapDatabaseError(pendingSelectionsRes.error);
  const reservedPointTicketIds = new Set((pendingSelectionsRes.data || []).map((row:any) => String(row.benefit_ref || "")).filter(Boolean));
  const balanceById = new Map((balancesRes.data || []).map((row:any) => [row.point_card_id,row]));
  const availableTickets = (ticketsRes.data || []).filter((row:any) => row.status === "available");
  const usedTickets = (ticketsRes.data || []).filter((row:any) => row.status === "used");
  const reservedStampsByCard = new Map<string,number>();
  for (const ticket of ticketsRes.data || []) {
    if (!reservedPointTicketIds.has(String(ticket.ticket_id || ""))) continue;
    const pointCardId = String(ticket.point_card_id || "");
    reservedStampsByCard.set(
      pointCardId,
      Number(reservedStampsByCard.get(pointCardId) || 0) + Math.max(0, Number(ticket.threshold_stamps || 0)),
    );
  }
  // Every awaiting-review snapshot counts as a separate planned use, even
  // when the same issued ticket is reserved for a later general booking.
  // The snapshot cost is not yet deducted from the point balance.
  const snapshotReservedStampsByCard = new Map<string,number>();
  for (const ticket of availableTickets) {
    if (ticket.status !== "available") continue;
    const snapshots = snapshotByPointTicket.get(String(ticket.ticket_id || "")) || [];
    if (!snapshots.length) continue;
    const pointCardId = String(ticket.point_card_id || "");
    const amount = Math.max(0, Number(ticket.threshold_stamps || 0)) * snapshots.length;
    snapshotReservedStampsByCard.set(pointCardId,
      Number(snapshotReservedStampsByCard.get(pointCardId) || 0) + amount);
  }
  const cardIdByUuid = new Map((rawCards.data || []).map((row:any) => [row.id,row.card_id]));
  const ticketByCard = new Map<string,any[]>();
  for (const ticket of availableTickets) {
    const cardId = cardIdByUuid.get(ticket.point_card_id) || "";
    const list = ticketByCard.get(cardId) || [];
    list.push({ ...pointTicketClient(ticket,cardId,reservedPointTicketIds.has(String(ticket.ticket_id || ""))), pendingSnapshot: (snapshotByPointTicket.get(String(ticket.ticket_id || "")) || [])[0] || null, pendingSnapshots: snapshotByPointTicket.get(String(ticket.ticket_id || "")) || [], bookingSelections: contextsForTicket(bookingSelections,"points",ticket.ticket_id), eligibleBookings: (bookingOptions.data as any)?.points?.[ticket.ticket_id] || [] });
    ticketByCard.set(cardId,list);
  }

  const cards = activeCards.map((card:any) => {
    const pointCardId = String(idByCard.get(card.cardId) || "");
    const balance = balanceById.get(pointCardId);
    const totalStamps = Math.max(0, Number(balance?.stamps || 0));
    const generalReservedStamps = Math.max(0, Number(reservedStampsByCard.get(pointCardId) || 0));
    const snapshotReservedStamps = Math.max(0, Number(snapshotReservedStampsByCard.get(pointCardId) || 0));
    const reservedStamps = generalReservedStamps + snapshotReservedStamps;
    const availableStamps = Math.max(0, totalStamps - reservedStamps);
    return {
      ...card,
      stamps: totalStamps,
      totalStamps,
      generalReservedStamps,
      snapshotReservedStamps,
      reservedStamps,
      availableStamps,
      updatedAt: balance?.updated_at || card.updatedAt,
    };
  });
  const cardDetails: Json = {};
  for (const card of cards) cardDetails[card.cardId] = { card, tickets: ticketByCard.get(card.cardId) || [] };

  const titleByCardId = new Map(activeCards.map((card:any) => [card.cardId,card.title]));
  const cardTitleByUuid = new Map((rawCards.data || []).map((row:any) => [row.id,titleByCardId.get(row.card_id) || "集點卡"]));
  const history = usedTickets.map((row:any) => ({
    activityId: "point-ticket:" + row.ticket_id,
    referenceId: row.ticket_id,
    ticketId: row.ticket_id,
    ticketType: row.ticket_type,
    ticketTitle: row.ticket_title,
    cardTitle: cardTitleByUuid.get(row.point_card_id) || "集點卡",
    pointsSpent: Number(row.points_spent || row.threshold_stamps || 0),
    result: row.result || null,
    occurredAt: row.used_at || row.updated_at,
  }));
  return { profile, cards, cardDetails, history, historyTotal: history.length, bookingSelections };
}

function eventTicketClient(row: any, claimedCount = 0, admin = false): Json {
  return {
    eventTicketId: row.event_ticket_id,
    title: row.title,
    ticketType: row.ticket_type,
    description: row.description || "",
    usageMethod: row.usage_method || "",
    usageInstructions: row.usage_instructions || "",
    prizes: Array.isArray(row.prizes) ? row.prizes : [],
    status: row.status,
    startsOn: row.starts_on || "",
    endsOn: row.ends_on || "",
    quota: Number(row.quota || 0),
    claimedCount,
    requiresLocation: Boolean(row.requires_location),
    redemptionLocationNames: Boolean(row.requires_location) && Array.isArray(row.redemption_locations)
      ? row.redemption_locations.map((location:any) => String(location.name || "")).filter(Boolean) : [],
    // Current admin-defined centres/radii: the server RPC still makes the authorization decision.
    redemptionLocations: Boolean(row.requires_location) && Array.isArray(row.redemption_locations)
      ? row.redemption_locations : [],
    ...(admin ? {
      redemptionLatitude: row.redemption_locations?.[0]?.latitude ?? null,
      redemptionLongitude: row.redemption_locations?.[0]?.longitude ?? null,
      redemptionRadiusMeters: row.redemption_locations?.[0]?.radiusMeters ?? null,
    } : {}),
    accent: row.accent,
    allowedTierKeys: Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [...TIER_KEYS],
    allowedTierLabels: (Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [...TIER_KEYS]).map((key:string) => TIER_LABELS[key]).filter(Boolean),
    requiredServiceIds: Array.isArray(row.required_service_ids) ? row.required_service_ids : [],
    requiredServiceMatchMode: Array.isArray(row.required_service_groups) && row.required_service_groups.length ? "groups" : row.required_service_match_mode === "all" ? "all" : "any",
    requiredServiceGroups: Array.isArray(row.required_service_groups) ? row.required_service_groups : [],
    requiredServiceTypes: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function claimClient(row: any, eventTicketId = ""): Json {
  return {
    claimId: row.claim_id,
    eventTicketId,
    ticketType: row.ticket_type,
    ticketTitle: row.ticket_title,
    ticketDescription: row.ticket_description || "",
    usageMethod: row.usage_method || "",
    usageInstructions: row.usage_instructions || "",
    prizes: Array.isArray(row.prizes) ? row.prizes : [],
    status: row.status === "claimed" ? "available" : row.status,
    claimedAt: row.claimed_at,
    usedAt: row.used_at || "",
    result: row.result || null,
  };
}

async function adminEventTickets(supabase: SupabaseClient): Promise<any[]> {
  const { data: rows, error } = await supabase.from("event_tickets").select("*").is("deleted_at",null).is("referral_source_event_ticket_id",null).order("created_at",{ ascending:false });
  if (error) throw mapDatabaseError(error);
  const ids = (rows || []).map((row:any) => row.id);
  const counts = new Map<string,number>();
  if (ids.length) {
    const claims = await supabase.rpc("event_ticket_claim_counts",{ p_event_ids:ids });
    if (claims.error) throw mapDatabaseError(claims.error);
    for (const claim of claims.data || []) counts.set(claim.event_ticket_id,Number(claim.claimed_count));
  }
  return (rows || []).map((row:any) => eventTicketClient(row,counts.get(row.id)||0,true));
}

async function eventBootstrap(supabase: SupabaseClient, member: any): Promise<Json> {
  const [profile,{ data: eventRows, error },allHistoryRes,pendingSelectionsRes,bookingOptions,bookingSelections,snapshotReceipts] = await Promise.all([
    profileFor(supabase,member),
    supabase.from("event_tickets").select("*").eq("status","active").is("deleted_at",null).order("created_at",{ ascending:false }),
    supabase.from("event_ticket_claims").select("*,event_tickets(*)").eq("member_id",member.id).eq("status","used").order("used_at",{ ascending:false }),
    supabase.from("booking_benefit_selections").select("benefit_ref")
      .eq("member_id",member.id).eq("benefit_kind","event").eq("status","pending"),
    supabase.rpc("member_ticket_booking_options", { p_member_id: member.id }),
    loadMemberBookingSelections(supabase, String(member.id)),
    supabase.from("booking_receipts").select("receipt_id,created_at,updated_at,requested_benefits")
      .eq("member_id",member.id).eq("submission_mode","accessible")
      .eq("status","awaiting_review").order("created_at",{ascending:false}).limit(100),
  ]);
  if (snapshotReceipts.error) throw mapDatabaseError(snapshotReceipts.error);
  const pendingSnapshotsByClaim = new Map<string,Json[]>();
  for (const receipt of snapshotReceipts.data || []) {
    for (const benefit of Array.isArray(receipt.requested_benefits) ? receipt.requested_benefits : []) {
      if (benefit?.kind !== "event" || !benefit.id) continue;
      const ref = String(benefit.id);
      const snapshots = pendingSnapshotsByClaim.get(ref) || [];
      if (!snapshots.some(item => item.receiptId === String(receipt.receipt_id)))
        snapshots.push({ receiptId:String(receipt.receipt_id),createdAt:String(receipt.created_at),updatedAt:String(receipt.updated_at) });
      pendingSnapshotsByClaim.set(ref,snapshots);
    }
  }
  if (bookingOptions.error) throw mapDatabaseError(bookingOptions.error);
  if (error) throw mapDatabaseError(error);
  const ids = (eventRows || []).map((row:any) => row.id);
  if (allHistoryRes.error) throw mapDatabaseError(allHistoryRes.error);
  if (pendingSelectionsRes.error) throw mapDatabaseError(pendingSelectionsRes.error);
  const reservedEventClaimIds = new Set((pendingSelectionsRes.data || []).map((row:any) => String(row.benefit_ref || "")).filter(Boolean));
  const [claimsRes,countRes] = ids.length
    ? await Promise.all([
      supabase.from("event_ticket_claims").select("*").eq("member_id",member.id).in("event_ticket_id",ids).order("created_at",{ ascending:false }),
      supabase.rpc("event_ticket_claim_counts",{ p_event_ids:ids }),
    ])
    : [{ data:[], error:null },{ data:[], error:null }];
  if (claimsRes.error) throw mapDatabaseError(claimsRes.error);
  if (countRes.error) throw mapDatabaseError(countRes.error);

  const claimByEvent = new Map((claimsRes.data || []).map((row:any) => [row.event_ticket_id,row]));
  const counts = new Map<string,number>();
  for (const row of countRes.data || []) counts.set(row.event_ticket_id,Number(row.claimed_count));
  const today = taipeiDate();
  const visibilityPolicy = await loadVisibilityPolicy(supabase);
  const offers = (eventRows || []).flatMap((row:any) => {
    const claimRow = claimByEvent.get(row.id);
    // Fixed tickets are server-issued member benefits, not public claimable offers.
    // Never expose a fixed-ticket event to a member unless that member owns its claim.
    if ((row.fixed_ticket_template_id || row.ticket_type === "referral" || row.ticket_type === "membership_join") && !claimRow) return [];
    if (claimRow && String(claimRow.status || "") === "used") return [];
    const ticket = eventTicketClient(row,counts.get(row.id)||0) as any;
    const claim = claimRow ? claimClient(claimRow,row.event_ticket_id) : null;
    const scheduled = Boolean(row.starts_on && today < row.starts_on);
    const ended = Boolean(row.ends_on && today > row.ends_on);
    const availability = scheduled ? "scheduled" : ended ? "ended" : "active";
    const visibility = tierVisibility(row.allowed_tier_keys,profile.tierKey,visibilityPolicy);
    if (!visibility.visible) return [];
    const tierEligible = visibility.tierEligible;
    const soldOut = Number(row.quota || 0) > 0 && (counts.get(row.id)||0) >= Number(row.quota);
    const reservedForBooking = Boolean(claimRow && reservedEventClaimIds.has(String(claimRow.claim_id || "")));
    const pendingSnapshots = claimRow ? pendingSnapshotsByClaim.get(String(claimRow.claim_id || "")) || [] : [];
    return [{
      ticket,
      claim,
      availability,
      tierEligible,
      locked:visibility.locked, lockReason:visibility.lockReason, requiredTierLabels:visibility.requiredTierLabels,
      canClaim: !["referral","membership_join"].includes(String(row.ticket_type || "")) && !claim && tierEligible && availability === "active" && !soldOut,
      canUse: Boolean(claim && claim.status === "available" && tierEligible && availability === "active" && !reservedForBooking && !pendingSnapshots.length && (bookingOptions.data as any)?.event?.[claimRow.claim_id]?.length),
      eligibleBookings: claimRow ? (bookingOptions.data as any)?.event?.[claimRow.claim_id] || [] : [],
      usageDisabledReason: "請先有管理員已確認、尚未完成且符合票券項目條件的預約。",
      reservedForBooking,
      pendingSnapshot: pendingSnapshots[0] || null,
      pendingSnapshots,
      bookingSelections: claimRow ? contextsForTicket(bookingSelections,"event",claimRow.claim_id) : [],
      soldOut,
      history: false,
    }];
  });

  const usedTickets = (allHistoryRes.data || []).map((row:any) => {
    const eventRow = row.event_tickets || {};
    const ticket = {
      eventTicketId: eventRow.event_ticket_id || row.claim_id,
      title: row.ticket_title,
      ticketType: row.ticket_type,
      description: row.ticket_description,
      usageMethod: row.usage_method,
      usageInstructions: row.usage_instructions,
      prizes: row.prizes || [],
      accent: eventRow.accent || "#df6b4d",
      allowedTierKeys: eventRow.allowed_tier_keys || [...TIER_KEYS],
      startsOn: eventRow.starts_on || "",
      endsOn: eventRow.ends_on || "",
    };
    return { ticket, claim: claimClient(row,eventRow.event_ticket_id || row.claim_id), availability:"used", tierEligible:true, canClaim:false, canUse:false, soldOut:false, history:true };
  });
  return { profile, offers, usedTickets, usedTicketCount: usedTickets.length, bookingSelections };
}

function calendarClient(row: any): Json {
  return {
    calendarItemId: row.calendar_item_id,
    title: row.title,
    itemType: row.item_type,
    description: row.description || "",
    startsOn: row.starts_on,
    endsOn: row.ends_on || "",
    status: row.status,
    accent: row.accent,
    allowedTierKeys: Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [],
    linkLabel: row.link_label || "",
    linkUrl: row.link_url || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function calendarItems(supabase: SupabaseClient, activeOnly = false): Promise<any[]> {
  let query = supabase.from("calendar_items").select("*").order("starts_on",{ ascending:true }).order("created_at",{ ascending:true });
  if (activeOnly) query = query.eq("status","active");
  const { data, error } = await query;
  if (error) throw mapDatabaseError(error);
  return (data || []).map(calendarClient);
}

async function summaryStats(supabase: SupabaseClient): Promise<Json> {
  const today = taipeiDate();
  const start = new Date(today + "T00:00:00+08:00").toISOString();
  const [members,activeMembers,cards,events,todayEntries] = await Promise.all([
    supabase.from("members").select("*",{ count:"exact",head:true }).eq("is_test_account",false),
    supabase.from("members").select("*",{ count:"exact",head:true }).eq("is_test_account",false).eq("status","active"),
    supabase.from("point_cards").select("*",{ count:"exact",head:true }).eq("status","active"),
    supabase.from("event_tickets").select("*",{ count:"exact",head:true }).eq("status","active").is("deleted_at",null).is("referral_source_event_ticket_id",null),
    supabase.from("point_entries").select("*",{ count:"exact",head:true }).gte("created_at",start).gt("amount",0),
  ]);
  for (const result of [members,activeMembers,cards,events,todayEntries]) if (result.error) throw mapDatabaseError(result.error);
  return {
    memberCount: members.count || 0,
    activeMemberCount: activeMembers.count || 0,
    activeCardCount: cards.count || 0,
    activeEventTicketCount: events.count || 0,
    todayEntryCount: todayEntries.count || 0,
  };
}

async function emitRealtime(supabase: SupabaseClient, action: string): Promise<void> {
  if (!WRITE_ACTIONS.has(action)) return;
  const presence = presenceActionInfo(action);
  if (presence) {
    if (presence.event === "heartbeat") return;
    await supabase.from("realtime_events").insert({ scope:"admin",event_type:action });
    return;
  }
  const scopes: ClientType[] =
    action.startsWith("admin.grant-message-presets.")
      ? ["admin"]
      : action.startsWith("admin.pointcards.") || action.startsWith("admin.tickets.") || action === "admin.stamps.add" || action === "user.pointcard.ticket.redeem"
      ? ["points","admin"]
      : action.startsWith("admin.event-tickets.") || action.startsWith("user.event.ticket.")
        ? ["event","admin"]
        : action.startsWith("admin.calendar-items.")
          ? ["calendar","admin"]
          : ["member","points","event","calendar","admin"];
  await supabase.from("realtime_events").insert([...new Set(scopes)].map((scope) => ({ scope,event_type:action })));
}


async function grantMessagePresets(supabase: SupabaseClient, includeArchived = true): Promise<any[]> {
  let query = supabase
    .from("grant_message_presets")
    .select("*")
    .order("sort_order",{ ascending:true })
    .order("created_at",{ ascending:true });
  if (!includeArchived) query = query.eq("status","active");
  const { data,error } = await query;
  if (error) throw mapDatabaseError(error);
  return (data || []).map((row:any) => ({
    presetId:row.preset_id,
    title:row.title,
    message:row.message,
    status:row.status,
    sortOrder:Number(row.sort_order || 0),
    createdAt:row.created_at,
    updatedAt:row.updated_at,
  }));
}

type GrantNotificationResult = {
  status: "sent" | "failed" | "skipped";
  message: string;
};

async function lineMessagingToken(supabase: SupabaseClient): Promise<string> {
  const result = await supabase.rpc("get_line_messaging_token");
  if (result.error) return "";
  return asText(result.data,10000);
}

function grantTicketItemLines(items: { label: string; status?: string }[], maxItems = 5): string[] {
  const grouped = new Map<string,{ label:string;status:string;count:number }>();
  for (const item of items) {
    const label = asText(item.label,180);
    const status = asText(item.status,40);
    if (!label) continue;
    const key = label + "\n" + status;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key,{ label,status,count:1 });
  }

  const entries = [...grouped.values()];
  const visible = entries.slice(0,maxItems).map((item) =>
    "・" + item.label + (item.count > 1 ? " ×" + item.count : "") + (item.status ? "（" + item.status + "）" : "")
  );
  const hiddenCount = entries.slice(maxItems).reduce((sum,item) => sum + item.count,0);
  if (hiddenCount > 0) visible.push("・另有 " + hiddenCount + " 張");
  return visible;
}

async function grantAvailableTicketSection(
  supabase: SupabaseClient,
  memberId: string,
  tierKey: string,
  grantedCardIds: string[],
): Promise<string> {
  const today = taipeiDate();
  const ticketBlocks: string[] = [];

  const pointCardsResult = await supabase
    .from("point_cards")
    .select("id,card_id,title,status,expiry_mode,expires_on")
    .eq("status","active");
  if (pointCardsResult.error) throw mapDatabaseError(pointCardsResult.error);

  const activePointCards = (pointCardsResult.data || []).filter((row:any) => !isExpiredCard(row));
  const pointCardsToIssue = activePointCards.filter((row:any) => grantedCardIds.includes(String(row.card_id)));
  if (pointCardsToIssue.length) {
    await Promise.all(pointCardsToIssue.map(async (row:any) => {
      const issueResult = await supabase.rpc("issue_eligible_point_tickets",{ p_member_id:memberId,p_point_card_id:row.id });
      if (issueResult.error) throw mapDatabaseError(issueResult.error);
    }));
  }

  const internalPointCardIds = activePointCards.map((row:any) => row.id);
  const pointTicketsResult = internalPointCardIds.length
    ? await supabase
        .from("point_tickets")
        .select("ticket_id,ticket_title,point_card_id,status,created_at")
        .eq("member_id",memberId)
        .eq("status","available")
        .in("point_card_id",internalPointCardIds)
        .order("created_at",{ ascending:false })
    : { data:[],error:null };
  if (pointTicketsResult.error) throw mapDatabaseError(pointTicketsResult.error);

  const pointCardTitleById = new Map(activePointCards.map((row:any) => [String(row.id),String(row.title || "集點卡")]));
  const pointTicketItems = (pointTicketsResult.data || []).map((row:any) => ({
      label: (pointCardTitleById.get(String(row.point_card_id)) || "集點卡") + "｜" + String(row.ticket_title || "可用票券"),
    }));
  if (pointTicketItems.length) {
    ticketBlocks.push(
      "集點卡票券 " + pointTicketItems.length + " 張\n" +
      grantTicketItemLines(pointTicketItems).join("\n")
    );
  }

  const eventTicketsResult = await supabase
    .from("event_tickets")
    .select("id,title,status,starts_on,ends_on,quota,allowed_tier_keys,created_at")
    .eq("status","active")
    .is("deleted_at",null)
    .order("created_at",{ ascending:false });
  if (eventTicketsResult.error) throw mapDatabaseError(eventTicketsResult.error);

  const eligibleEventRows = (eventTicketsResult.data || []).filter((row:any) => {
    const scheduled = Boolean(row.starts_on && today < String(row.starts_on));
    const ended = Boolean(row.ends_on && today > String(row.ends_on));
    const allowedTierKeys = Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [];
    return !scheduled && !ended && allowedTierKeys.includes(tierKey);
  });
  const eventIds = eligibleEventRows.map((row:any) => row.id);

  const memberClaimsResult = eventIds.length
    ? await supabase
        .from("event_ticket_claims")
        .select("event_ticket_id,status")
        .eq("member_id",memberId)
        .in("event_ticket_id",eventIds)
    : { data:[],error:null };
  if (memberClaimsResult.error) throw mapDatabaseError(memberClaimsResult.error);

  const claimCountsResult = eventIds.length
    ? await supabase
        .from("event_ticket_claims")
        .select("event_ticket_id")
        .in("event_ticket_id",eventIds)
    : { data:[],error:null };
  if (claimCountsResult.error) throw mapDatabaseError(claimCountsResult.error);

  const memberClaimByEvent = new Map((memberClaimsResult.data || []).map((row:any) => [String(row.event_ticket_id),String(row.status || "")]));
  const claimCounts = new Map<string,number>();
  for (const row of claimCountsResult.data || []) {
    const eventId = String(row.event_ticket_id);
    claimCounts.set(eventId,(claimCounts.get(eventId) || 0) + 1);
  }

  const eventTicketItems: { label:string;status:string }[] = [];
  for (const row of eligibleEventRows) {
    const eventId = String(row.id);
    const claimStatus = memberClaimByEvent.get(eventId) || "";
    if (claimStatus === "claimed" || claimStatus === "available") {
      eventTicketItems.push({ label:String(row.title || "活動票券"),status:"已領取，可使用" });
      continue;
    }
    if (claimStatus) continue;
    const quota = Number(row.quota || 0);
    const soldOut = quota > 0 && (claimCounts.get(eventId) || 0) >= quota;
    if (!soldOut) eventTicketItems.push({ label:String(row.title || "活動票券"),status:"可領取" });
  }
  if (eventTicketItems.length) {
    ticketBlocks.push(
      "活動票券 " + eventTicketItems.length + " 張\n" +
      grantTicketItemLines(eventTicketItems).join("\n")
    );
  }

  return ticketBlocks.length
    ? "【目前可用票券】\n" + ticketBlocks.join("\n\n") + "\n請至會員系統查看與使用。"
    : "";
}

async function pushGrantNotification(
  supabase: SupabaseClient,
  lineUserId: string,
  memberDisplayName: string,
  memberId: string,
  requestIdValue: string,
  points: unknown,
  serviceMinutes: number,
  presetMessage: string,
  totalServiceMinutes: number,
  tierKey: string,
  tierLabel: string,
): Promise<GrantNotificationResult> {
  const token = await lineMessagingToken(supabase);
  if (!token) return { status:"failed",message:"LINE Messaging API 尚未設定。" };

  const greetingName = asText(memberDisplayName,120) || "會員";
  const announcement = asText(presetMessage,1000);
  const sections: string[] = [];
  const pointItems = Array.isArray(points)
    ? points.filter((item) => item && typeof item === "object") as Json[]
    : [];
  const cardIds = [...new Set(pointItems.map((item) => asText(item.cardId,120)).filter(Boolean))];

  if (cardIds.length) {
    const cardsResult = await supabase.from("point_cards").select("id,card_id,title").in("card_id",cardIds);
    if (cardsResult.error) throw mapDatabaseError(cardsResult.error);
    const cards = cardsResult.data || [];
    const internalIds = cards.map((row:any) => row.id);
    const balancesResult = internalIds.length
      ? await supabase.from("point_balances").select("point_card_id,stamps").eq("member_id",memberId).in("point_card_id",internalIds)
      : { data:[],error:null };
    if (balancesResult.error) throw mapDatabaseError(balancesResult.error);

    const cardsByPublicId = new Map(cards.map((row:any) => [String(row.card_id),row]));
    const balances = new Map((balancesResult.data || []).map((row:any) => [String(row.point_card_id),Number(row.stamps || 0)]));

    for (const item of pointItems) {
      const cardId = asText(item.cardId,120);
      const amount = Number(item.amount || 0);
      if (!cardId || !Number.isFinite(amount) || amount <= 0) continue;
      const card:any = cardsByPublicId.get(cardId);
      if (!card) continue;
      sections.push(
        "【點數發放】\n" +
        String(card.title || "集點卡") + "\n" +
        "本次發放：+" + amount + " 點\n" +
        "目前點數：" + Number(balances.get(String(card.id)) || 0) + " 點"
      );
    }
  }

  if (serviceMinutes > 0) {
    sections.push(
      "【服務時間發放】\n" +
      "本次發放：+" + serviceMinutes + " 分鐘\n" +
      "目前服務時間：" + totalServiceMinutes + " 分鐘\n" +
      "會員等級：" + tierLabel
    );
  }

  if (!sections.length) return { status:"skipped",message:"本次沒有需要推播的發放內容。" };

  try {
    const ticketSection = await grantAvailableTicketSection(supabase,memberId,tierKey,cardIds);
    if (ticketSection) sections.push(ticketSection);
  } catch {
    // 票券摘要屬於附加資訊；同步失敗時仍需送出主要發放通知，避免成功發放卻沒有 LINE 訊息。
  }

  const messageText = (greetingName + " 您好！\n\n" + (announcement ? announcement + "\n\n" : "") + sections.join("\n\n")).slice(0,4500);
  const body = {
    to: lineUserId,
    messages: [buildLineFlexNotice(messageText,{
      title:"會員權益通知",
      eyebrow:"MEMBER BENEFITS",
    })],
  };

  let response: Response;
  try {
    response = await fetch("https://api.line.me/v2/bot/message/push",{
      method:"POST",
      headers:{
        "Authorization":"Bearer " + token,
        "Content-Type":"application/json",
        "X-Line-Retry-Key":crypto.randomUUID(),
      },
      body:JSON.stringify(body),
    });
  } catch {
    await supabase.from("audit_logs").insert({
      audit_id:requestId("AUD"),
      actor_line_user_id:null,
      actor_role:"system",
      action:"line.push.grant",
      target_type:"member",
      target_id:lineUserId,
      result:"failed",
      detail:{ requestId:requestIdValue,reason:"network_error" },
    });
    return { status:"failed",message:"發放已成功，但 LINE 推播連線失敗。" };
  }

  const lineRequestId = response.headers.get("x-line-request-id") || "";
  await supabase.from("audit_logs").insert({
    audit_id:requestId("AUD"),
    actor_line_user_id:null,
    actor_role:"system",
    action:"line.push.grant",
    target_type:"member",
    target_id:lineUserId,
    result:response.ok ? "success" : "failed",
    detail:{ requestId:requestIdValue,httpStatus:response.status,lineRequestId },
  });

  if (!response.ok) {
    return { status:"failed",message:"發放已成功，但 LINE 推播未送達。" };
  }
  return { status:"sent",message:"發放成功，LINE 通知已送出。" };
}

async function saveTicketTemplate(supabase: SupabaseClient, actor: string, body: Json): Promise<Json> {
  const ticket = body.ticket && typeof body.ticket === "object" ? body.ticket as Json : {};
  const ticketTemplateId = asText(ticket.ticketTemplateId,100);
  const title = requireText(ticket.title,"票券名稱",100);
  const ticketType = asText(ticket.ticketType,20);
  if (!["coupon","lottery"].includes(ticketType)) throw new ApiError(400,"INVALID_TICKET_TYPE","票券類型不合法。");
  const prizes = normalizePrizes(ticket.prizes,ticketType === "lottery");
  const requiresLocation = ticket.requiresLocation === true;
  const redemptionLocations = normalizeTicketLocations(ticket.redemptionLocations,requiresLocation);
  const payload = {
    title,
    ticket_type: ticketType,
    description: requireText(ticket.description,"票券說明",240),
    usage_method: requireText(ticket.usageMethod,"使用方式",120),
    usage_instructions: requireText(ticket.usageInstructions,"使用說明",500),
    prizes,
    status: requireStatus(ticket.status),
    requires_location: requiresLocation,
    redemption_locations: redemptionLocations,
    updated_by: actor,
    updated_at: new Date().toISOString(),
  };
  let row;
  if (ticketTemplateId) {
    const current = await supabase.from("ticket_templates").select("*").eq("ticket_template_id",ticketTemplateId).single();
    if (current.error) throw new ApiError(404,"TICKET_TEMPLATE_NOT_FOUND","找不到指定票券。");
    const expected = asText(body.expectedUpdatedAt,100);
    if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","票券已被其他管理者更新，請重新整理。");
    const result = await supabase.from("ticket_templates").update(payload).eq("id",current.data.id).select("*").single();
    if (result.error) throw mapDatabaseError(result.error);
    row = result.data;
  } else {
    const result = await supabase.from("ticket_templates").insert({
      ticket_template_id: requestId("TT"),
      ...payload,
      created_by: actor,
    }).select("*").single();
    if (result.error) throw mapDatabaseError(result.error);
    row = result.data;
  }
  return { ticket: mapTicketTemplate(row) };
}

async function saveEventTicket(supabase: SupabaseClient, actor: string, body: Json): Promise<Json> {
  const input = body.eventTicket && typeof body.eventTicket === "object" ? body.eventTicket as Json : {};
  const id = asText(input.eventTicketId,100);
  const ticketType = asText(input.ticketType,20);
  if (!["coupon","lottery","referral","membership_join"].includes(ticketType)) throw new ApiError(400,"INVALID_TICKET_TYPE","票券類型不合法。");
  const status = requireStatus(input.status);
  const startsOn = asText(input.startsOn,20);
  const endsOn = asText(input.endsOn,20);
  if (startsOn && !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw new ApiError(400,"INVALID_DATE","活動開始日格式不正確。");
  if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) throw new ApiError(400,"INVALID_DATE","活動結束日格式不正確。");
  if (startsOn && endsOn && endsOn < startsOn) throw new ApiError(400,"INVALID_DATE_RANGE","活動結束日不可早於開始日。");
  const quota = Number(input.quota || 0);
  if (!Number.isInteger(quota) || quota < 0 || quota > 1_000_000) throw new ApiError(400,"INVALID_QUOTA","限量張數必須是 0–1,000,000。");
  const requiresLocation = ticketType === "referral" ? false : input.requiresLocation === true;
  // Older admin tabs still send the original single-site fields during rollout.
  const rawLocations = Array.isArray(input.redemptionLocations) ? input.redemptionLocations
    : requiresLocation ? [{ name: "原核銷地點", latitude: input.redemptionLatitude,
      longitude: input.redemptionLongitude, radiusMeters: input.redemptionRadiusMeters }] : [];
  if (requiresLocation && (!Array.isArray(rawLocations) || rawLocations.length < 1 || rawLocations.length > 20))
    throw new ApiError(400,"INVALID_LOCATION_RULE","請為票券設定 1–20 個核銷地點。");
  const locations = requiresLocation ? rawLocations.map((location:any) => ({
    name: typeof location?.name === "string" ? location.name.trim() : "",
    latitude: location?.latitude === "" || location?.latitude == null ? NaN : Number(location.latitude),
    longitude: location?.longitude === "" || location?.longitude == null ? NaN : Number(location.longitude),
    radiusMeters: location?.radiusMeters === "" || location?.radiusMeters == null ? NaN : Number(location.radiusMeters),
  })) : [];
  if (locations.some((location:any) => !location.name || location.name.length > 100
    || !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90
    || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180
    || !Number.isInteger(location.radiusMeters) || location.radiusMeters < 50 || location.radiusMeters > 2000))
    throw new ApiError(400,"INVALID_LOCATION_RULE","每個地點需有名稱、有效座標與 50–2000 公尺半徑。");
  const requiredServiceIds = input.requiredServiceIds !== undefined
    ? await normalizeRequiredServiceIds(supabase,input.requiredServiceIds)
    : await serviceIdsForLegacyTypes(supabase,input.requiredServiceTypes);
  const groupMode = input.requiredServiceMatchMode === "groups";
  const requiredServiceGroups = groupMode ? await normalizeRequiredServiceGroups(supabase, input.requiredServiceGroups) : [];
  if (groupMode && !requiredServiceGroups.length) throw new ApiError(400,"INVALID_REQUIRED_SERVICE_GROUPS","請至少設定一個有效的預約組合。");
  const requiredServiceMatchMode = input.requiredServiceMatchMode === "all" ? "all" : "any";
  const payload = {
    title: requireText(input.title,"活動票券名稱",100),
    ticket_type: ticketType,
    description: requireText(input.description,"票券說明",240),
    usage_method: requireText(input.usageMethod,"使用方式",120),
    usage_instructions: requireText(input.usageInstructions,"使用說明",500),
    prizes: normalizePrizes(input.prizes,ticketType === "lottery"),
    status,
    starts_on: startsOn || null,
    ends_on: endsOn || null,
    quota,
    requires_location: requiresLocation,
    redemption_locations: locations,
    accent: requireAccent(input.accent),
    allowed_tier_keys: normalizeTierKeys(input.allowedTierKeys),
    required_service_ids: groupMode ? [] : requiredServiceIds,
    required_service_match_mode: requiredServiceMatchMode,
    required_service_groups: requiredServiceGroups,
    updated_by: actor,
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  if (ticketType === "referral" && status === "active") {
    const activeReferral = await supabase.from("event_tickets")
      .select("event_ticket_id")
      .eq("ticket_type","referral")
      .eq("status","active")
      .is("deleted_at",null)
      .is("referral_source_event_ticket_id",null)
      .neq("event_ticket_id", id || "__new__")
      .limit(1);
    if (activeReferral.error) throw mapDatabaseError(activeReferral.error);
    if ((activeReferral.data || []).length) throw new ApiError(409,"REFERRAL_REWARD_ALREADY_ACTIVE","同時間只能啟用一個好友邀請票券，請先封存目前啟用中的好友邀請票券。");
  }
  if (ticketType === "membership_join" && status === "active") {
    const activeJoinReward = await supabase.from("event_tickets")
      .select("event_ticket_id")
      .eq("ticket_type","membership_join")
      .eq("status","active")
      .is("deleted_at",null)
      .neq("event_ticket_id", id || "__new__")
      .limit(1);
    if (activeJoinReward.error) throw mapDatabaseError(activeJoinReward.error);
    if ((activeJoinReward.data || []).length) throw new ApiError(409,"MEMBERSHIP_JOIN_REWARD_ALREADY_ACTIVE","同時間只能啟用一個加入會員票券，請先封存目前啟用中的加入會員票券。");
  }
  let row;
  if (id) {
    const current = await supabase.from("event_tickets").select("*").eq("event_ticket_id",id).is("deleted_at",null).single();
    if (current.error) throw new ApiError(404,"EVENT_TICKET_NOT_FOUND","找不到指定活動票券。");
    const expected = asText(body.expectedUpdatedAt,100);
    if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","活動票券已被其他管理者更新，請重新整理。");
    const result = await supabase.from("event_tickets").update(payload).eq("id",current.data.id).select("*").single();
    if (result.error) throw mapDatabaseError(result.error);
    row = result.data;
  } else {
    const result = await supabase.from("event_tickets").insert({
      event_ticket_id: requestId("EVT"),
      ...payload,
      created_by: actor,
    }).select("*").single();
    if (result.error) throw mapDatabaseError(result.error);
    row = result.data;
  }
  const claims = await supabase.from("event_ticket_claims").select("*",{ count:"exact",head:true }).eq("event_ticket_id",row.id);
  if (claims.error) throw mapDatabaseError(claims.error);
  return { eventTicket:eventTicketClient(row,claims.count || 0,true) };
}


async function adminIntegrationOverview(supabase: SupabaseClient): Promise<Json> {
  const [
    stats,
    pointCardsRes,
    serviceTypesRes,
    serviceRewardsRes,
    fixedTicketsRes,
    calendarRes,
    eventTicketsRes,
    scheduledRes,
    settlementsRes,
  ] = await Promise.all([
    summaryStats(supabase),
    supabase.from("point_cards").select("id,card_id,title,status").order("sort_order",{ ascending:true }),
    supabase.from("booking_service_types").select("id,name,sort_order,updated_at").order("sort_order",{ ascending:true }),
    supabase.from("booking_service_type_rewards").select("service_type_id,point_card_id,minutes_per_point,updated_at"),
    supabase.from("fixed_ticket_templates")
      .select("fixed_ticket_id,title,status,schedule_type,schedule_month,schedule_day,schedule_weekday,quota,allowed_tier_keys,notify_line,expiry_mode,expiry_date,expiry_days,calendar_enabled,updated_at")
      .is("deleted_at",null)
      .order("updated_at",{ ascending:false })
      .limit(40),
    supabase.from("calendar_items")
      .select("calendar_item_id,title,item_type,status,starts_on,ends_on,allowed_tier_keys,bonus_points_enabled,bonus_points,source_event_ticket_id,updated_at")
      .order("starts_on",{ ascending:false })
      .limit(100),
    supabase.from("event_tickets")
      .select("id,event_ticket_id,title,status,starts_on,ends_on,allowed_tier_keys,fixed_ticket_template_id,updated_at")
      .is("deleted_at",null)
      .is("referral_source_event_ticket_id",null)
      .order("updated_at",{ ascending:false })
      .limit(60),
    supabase.from("scheduled_grant_messages")
      .select("schedule_id,member_id,scheduled_for,status,attempt_count,last_error,created_at,sent_at")
      .order("created_at",{ ascending:false })
      .limit(60),
    supabase.from("booking_completion_settlements")
      .select("booking_id,member_id,service_minutes,reward_details,created_at")
      .order("created_at",{ ascending:false })
      .limit(40),
  ]);

  for (const result of [
    pointCardsRes,serviceTypesRes,serviceRewardsRes,fixedTicketsRes,calendarRes,
    eventTicketsRes,scheduledRes,settlementsRes,
  ]) {
    if (result.error) throw mapDatabaseError(result.error);
  }

  const pointCards = pointCardsRes.data || [];
  const serviceTypes = serviceTypesRes.data || [];
  const serviceRewards = serviceRewardsRes.data || [];
  const fixedTickets = fixedTicketsRes.data || [];
  const calendarRows = calendarRes.data || [];
  const eventTickets = eventTicketsRes.data || [];
  const scheduledRows = scheduledRes.data || [];
  const settlements = settlementsRes.data || [];

  const memberIds = [...new Set([
    ...scheduledRows.map((row:any) => row.member_id),
    ...settlements.map((row:any) => row.member_id),
  ].filter(Boolean))];
  const membersByIdRes = memberIds.length
    ? await supabase.from("members").select("id,display_name,member_code,is_test_account").in("id",memberIds)
    : { data:[],error:null };
  if (membersByIdRes.error) throw mapDatabaseError(membersByIdRes.error);
  const memberById = new Map((membersByIdRes.data || []).map((row:any) => [row.id,row]));
  const cardById = new Map(pointCards.map((row:any) => [row.id,row]));
  const typeById = new Map(serviceTypes.map((row:any) => [row.id,row]));
  const calendarByEventTicketId = new Map<string,any>();
  for (const row of calendarRows) {
    if (row.source_event_ticket_id) calendarByEventTicketId.set(String(row.source_event_ticket_id),row);
  }

  const pointSources:any[] = [];
  for (const reward of serviceRewards) {
    const type = typeById.get(reward.service_type_id);
    const card = cardById.get(reward.point_card_id);
    pointSources.push({
      sourceType:"booking",
      sourceId:String(reward.service_type_id || ""),
      title:String(type?.name || "預約項目類型"),
      detail:`每 ${Number(reward.minutes_per_point || 0)} 分鐘 +1 點`,
      pointCardId:String(card?.card_id || ""),
      pointCardTitle:String(card?.title || "指定集點卡"),
      status:card?.status === "active" ? "active" : "attention",
      updatedAt:reward.updated_at || type?.updated_at || "",
    });
  }
  for (const item of calendarRows) {
    if (item.item_type !== "event" || item.bonus_points_enabled !== true || Number(item.bonus_points || 0) <= 0) continue;
    pointSources.push({
      sourceType:"calendar",
      sourceId:String(item.calendar_item_id || ""),
      title:String(item.title || "日曆活動"),
      detail:`會員發放操作搭配此活動時，每張集點卡 +${Number(item.bonus_points || 0)} 點`,
      pointCardId:"",
      pointCardTitle:"依本次發放集點卡",
      status:item.status === "active" ? "active" : "attention",
      updatedAt:item.updated_at || "",
    });
  }
  pointSources.push({
    sourceType:"manual",
    sourceId:"admin-member-grant",
    title:"管理員手動發放",
    detail:"會員 360／會員名冊可發放多張集點卡點數與服務時間",
    pointCardId:"",
    pointCardTitle:"操作時選擇",
    status:"active",
    updatedAt:"",
  });

  const campaignRows = eventTickets.map((row:any) => {
    const linked = calendarByEventTicketId.get(String(row.id || ""));
    return {
      eventTicketId:String(row.event_ticket_id || ""),
      title:String(row.title || "活動票券"),
      status:String(row.status || "draft"),
      startsOn:row.starts_on || "",
      endsOn:row.ends_on || "",
      allowedTierKeys:Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [],
      fixedTicketManaged:Boolean(row.fixed_ticket_template_id),
      calendarLinked:Boolean(linked),
      calendarItemId:String(linked?.calendar_item_id || ""),
    };
  });

  const notifications = scheduledRows.map((row:any) => {
    const member = memberById.get(row.member_id);
    return {
      scheduleId:String(row.schedule_id || ""),
      memberDisplayName:String(member?.display_name || "會員"),
      memberCode:String(member?.member_code || ""),
      isTestAccount:member?.is_test_account === true,
      scheduledFor:row.scheduled_for || "",
      status:String(row.status || "pending"),
      attemptCount:Number(row.attempt_count || 0),
      lastError:String(row.last_error || ""),
      createdAt:row.created_at || "",
      sentAt:row.sent_at || "",
    };
  });

  const settlementRows = settlements.map((row:any) => {
    const member = memberById.get(row.member_id);
    const rewards = Array.isArray(row.reward_details)
      ? row.reward_details
      : row.reward_details && typeof row.reward_details === "object"
        ? Object.values(row.reward_details as Record<string,unknown>)
        : [];
    return {
      bookingId:String(row.booking_id || ""),
      memberDisplayName:String(member?.display_name || "會員"),
      memberCode:String(member?.member_code || ""),
      serviceMinutes:Number(row.service_minutes || 0),
      rewardCount:rewards.length,
      rewardDetails:row.reward_details || null,
      createdAt:row.created_at || "",
    };
  });

  return {
    stats,
    pointSources,
    automation:{
      fixedTickets:fixedTickets.map((row:any) => ({
        fixedTicketId:String(row.fixed_ticket_id || ""),
        title:String(row.title || "固定票券"),
        status:String(row.status || "draft"),
        scheduleType:String(row.schedule_type || ""),
        scheduleMonth:row.schedule_month,
        scheduleDay:row.schedule_day,
        scheduleWeekday:row.schedule_weekday,
        quota:Number(row.quota || 0),
        allowedTierKeys:Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [],
        notifyLine:row.notify_line === true,
        expiryMode:String(row.expiry_mode || ""),
        expiryDate:row.expiry_date || "",
        expiryDays:row.expiry_days,
        calendarEnabled:row.calendar_enabled === true,
        updatedAt:row.updated_at || "",
      })),
    },
    campaigns:campaignRows,
    notifications,
    settlements:settlementRows,
    generatedAt:new Date().toISOString(),
  };
}

async function handleAction(supabase: SupabaseClient, identity: { lineUserId: string; displayName: string; issuedAtMs?: number }, action: string, body: Json): Promise<Json> {
  if (action === 'admin.sync.status' || /^user\.(member|points|event|calendar|booking)\.sync\.status$/.test(action))
    return await syncRevision(supabase, clientTypeForAction(action), identity.lineUserId,
      (status:number,code:string,message:string) => new ApiError(status,code,message));
  if (action === "user.pointcard.snapshot-ticket.cancel" || action === "user.event.snapshot-ticket.cancel") {
    const member = await requireJoinedMember(supabase,identity);
    const receiptId = requireText(body.receiptId,"快照識別",80);
    const ticketId = requireText(body.ticketId,"票券識別",120);
    const expectedUpdatedAt = requireText(body.expectedUpdatedAt,"快照版本",80);
    if (!/^BR-[a-f0-9]{32}$/i.test(receiptId) || !(action.startsWith("user.pointcard") ? /^PT-[a-f0-9]{32}$/i : /^EC-[a-f0-9]{32}$/i).test(ticketId)
      || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      throw new ApiError(400,"INVALID_INPUT","快照或票券識別不正確，請重新整理。");
    }
    const result = await supabase.rpc(action.startsWith("user.pointcard")
      ? "member_cancel_snapshot_point_ticket_request"
      : "member_cancel_snapshot_event_ticket_request",{
      p_line_user_id:identity.lineUserId,
      p_receipt_id:receiptId,p_ticket_id:ticketId,p_expected_updated_at:expectedUpdatedAt,
    });
    if (result.error) throw mapDatabaseError(result.error);
    return result.data || { cancelled:true };
  }
  if (/^user\.(pointcard|event)\.booking-selections\.(detail|update)$/.test(action)) {
    const member = await requireJoinedMember(supabase, identity);
    const bookingId = requireText(body.bookingId,"預約識別",60);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId))
      throw new ApiError(400,"INVALID_BOOKING_ID","預約識別格式不正確。");
    let change = null;
    if (action.endsWith(".update")) {
      const version = asText(body.expectedUpdatedAt,80);
      if (!version || !Number.isFinite(Date.parse(version))) throw new ApiError(400,"INVALID_BOOKING_VERSION","缺少有效預約版本，請重新載入。");
      const updated = await supabase.rpc("member_update_booking_benefits_request", {
        p_line_user_id:identity.lineUserId,p_booking_id:bookingId,
        p_expected_updated_at:asText(body.expectedUpdatedAt,80) || null,
        p_request_id:requireText(body.requestId,"操作識別碼",100),p_benefits:body.benefits,
      });
      if (updated.error) {
        const error = mapDatabaseError(updated.error);
        const failure = await supabase.from("booking_audit_events").insert({
          actor_line_user_id:identity.lineUserId,actor_role:"member",action:"BOOKING_BENEFITS_UPDATE_FAILED",
          target_type:"booking",target_id:bookingId,result:"failed",metadata:{errorCode:error.code},
        });
        if (failure.error) console.error("selection rejection audit unavailable",failure.error.code);
        throw error;
      }
      change = updated.data;
    }
    const bookings = await loadMemberBookingSelections(supabase,String(member.id));
    const booking = bookings.find(b => b.bookingId === bookingId);
    if (!booking) throw new ApiError(409,"BOOKING_NOT_EDITABLE","預約已取消或結算，請更新票券資料。");
    const profile = await profileFor(supabase,member);
    return { booking, change, options:booking.editable ? await loadBookingBenefits(supabase,member,String(profile.tierKey),taipeiDate(),bookingId) : { items:[] } };
  }
  // Revalidate a verified member token after login-takeover broadcasts.
  // The shared auth contract checks current token grants before this handler.
  if (/^user\.(member|points|event|calendar|booking)\.session\.status$/.test(action)) {
    return { state:"active" };
  }
  if (/^(?:admin|user\.(?:member|points|event|calendar|booking))\.session\.claim$/.test(action)) {
    if (action.startsWith("admin.")) {
      // Admin workspaces may coexist on multiple devices. Do not claim or
      // replace the member's single-login session for the same LINE identity.
      await authorizeAdmin(supabase, identity);
      return { state:"concurrent" };
    } else {
      // A disabled account must not displace its previously connected browser.
      // Missing member rows are legitimate before first-time onboarding.
      const member = await supabase.from("members")
        .select("status").eq("line_user_id",identity.lineUserId).maybeSingle();
      if (member.error) throw mapDatabaseError(member.error);
      if (member.data && member.data.status !== "active") {
        throw new ApiError(403, "MEMBER_DISABLED", "此會員目前已停用。");
      }
    }
    const browserKey = requireText(body.browserKey, "瀏覽器登入識別", 120);
    if (!/^[a-f0-9-]{72}$/.test(browserKey)) throw new ApiError(400, "INVALID_LOGIN_KEY", "瀏覽器登入識別不正確。");
    const mode = asText(body.mode, 10);
    if (mode !== "login" && mode !== "resume") throw new ApiError(400, "INVALID_LOGIN_MODE", "登入模式不正確。");
    const result = await supabase.rpc("member_login_claim", {
      p_line_user_id: identity.lineUserId,
      p_browser_hash: await sha256(browserKey),
      p_token_hash: await sha256(asText(body.idToken, 10000)),
      p_issued_at_ms: identity.issuedAtMs || 0,
      p_mode: mode,
    });
    if (result.error) throw mapDatabaseError(result.error);
    if (result.data === "session_replaced") throw new ApiError(401, "SESSION_REPLACED", "此帳號已在其他裝置登入，您已被登出。");
    if (!["claimed", "resumed", "replaced"].includes(String(result.data))) {
      throw new ApiError(503, "LOGIN_CLAIM_FAILED", "目前無法建立登入連線。");
    }
    if (result.data !== "resumed") {
      const audit = await supabase.from("audit_logs").insert({
        audit_id: requestId("AUD"),actor_line_user_id:identity.lineUserId,
        actor_role:action.startsWith("admin.") ? "admin" : "member",
        action:result.data === "replaced" ? "LOGIN_SESSION_REPLACED" : "LOGIN_SESSION_CREATED",
        target_type:"member",target_id:identity.lineUserId,result:"success",
        detail:{ clientType:clientTypeForAction(action) },
      });
      if (audit.error) console.error("login session audit unavailable",audit.error.code);
    }
    return { state:String(result.data) };
  }
  if (/^(?:admin|user\.(?:member|points|event|calendar|booking))\.session\.logout$/.test(action)) {
    // The admin LIFF logout is local to that workspace. It must not revoke
    // a member session or another administrator's login.
    if (action === "admin.session.logout") return { revoked:false };
    const result = await supabase.rpc("member_login_logout",{
      p_line_user_id:identity.lineUserId,p_token_hash:await sha256(asText(body.idToken,10000)),
    });
    if (result.error) throw mapDatabaseError(result.error);
    if (result.data === true) {
      const audit = await supabase.from("audit_logs").insert({
        audit_id:requestId("AUD"),actor_line_user_id:identity.lineUserId,
        actor_role:action.startsWith("admin.") ? "admin" : "member",
        action:"LOGIN_SESSION_LOGOUT",target_type:"member",
        target_id:identity.lineUserId,result:"success",
        detail:{clientType:clientTypeForAction(action)},
      });
      if (audit.error) console.error("session logout audit unavailable",audit.error.code);
    }
    return { revoked: result.data === true };
  }
  const presence = presenceActionInfo(action);
  if (presence) {
    const sessionId = requireText(body.sessionId,"上線紀錄識別",80);
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(sessionId)) throw new ApiError(400,"INVALID_PRESENCE_SESSION","上線紀錄識別格式不正確。");
    const reason = asText(body.reason,30) || (presence.event === "online" ? "signin" : presence.event === "heartbeat" ? "heartbeat" : "pagehide");
    if (!["signin","logout","pagehide","hidden","bfcache","resume","relogin","heartbeat"].includes(reason)) {
      throw new ApiError(400,"INVALID_PRESENCE_REASON","上下線紀錄原因不合法。");
    }

    let member:any;
    if (presence.event === "online") {
      member = await ensureMember(supabase,identity);
    } else {
      const existing = await supabase.from("members").select("id").eq("line_user_id",identity.lineUserId).maybeSingle();
      if (existing.error) throw mapDatabaseError(existing.error);
      if (!existing.data) throw new ApiError(404,"MEMBER_NOT_FOUND","找不到指定會員。");
      member = existing.data;
    }

    const now = new Date().toISOString();
    if (presence.event === "online") {
      const upsert = await supabase.from("member_presence_sessions").upsert({
        member_id:member.id,
        session_id:sessionId,
        surface:presence.surface,
        online_at:now,
        last_seen_at:now,
        offline_at:null,
        offline_reason:null,
        updated_at:now,
      },{ onConflict:"member_id,session_id" });
      if (upsert.error) throw mapDatabaseError(upsert.error);
      const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      EdgeRuntime.waitUntil((async () => {
        try {
          const cleanup = await supabase.from("member_presence_sessions")
            .delete()
            .eq("member_id",member.id)
            .lt("last_seen_at",staleCutoff);
          if (cleanup.error) console.error("member presence cleanup failed", cleanup.error.message);
        } catch (error) {
          console.error("member presence cleanup failed", error);
        }
      })());
    } else if (presence.event === "heartbeat") {
      const heartbeat = await supabase.from("member_presence_sessions")
        .update({ surface:presence.surface,last_seen_at:now,updated_at:now })
        .eq("member_id",member.id)
        .eq("session_id",sessionId)
        .is("offline_at",null);
      if (heartbeat.error) throw mapDatabaseError(heartbeat.error);
      return { recorded:true,event:presence.event,surface:presence.surface,sessionId,lastSeenAt:now };
    } else {
      const offline = await supabase.from("member_presence_sessions")
        .update({ last_seen_at:now,offline_at:now,offline_reason:reason,updated_at:now })
        .eq("member_id",member.id)
        .eq("session_id",sessionId);
      if (offline.error) throw mapDatabaseError(offline.error);
    }

    const inserted = await supabase.from("audit_logs").insert({
      audit_id:requestId("AUD"),
      actor_line_user_id:identity.lineUserId,
      actor_role:"member",
      action,
      target_type:"member",
      target_id:identity.lineUserId,
      result:"success",
      detail:{ sessionId,surface:presence.surface,reason },
    });
    if (inserted.error) throw mapDatabaseError(inserted.error);
    return { recorded:true,event:presence.event,surface:presence.surface,sessionId,lastSeenAt:now };
  }

  if (action === "user.member.bootstrap") {
    const member = await ensureMember(supabase,identity);
    return { profile: await profileFor(supabase,member) };
  }
  if (action === "user.member.profile.save") {
    const member = await ensureMember(supabase,identity);
    const birthday = asText(body.birthday,20);
    const phone = asText(body.phone,30).replace(/[()\s-]/g,"");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw new ApiError(400,"INVALID_BIRTHDAY","請填寫正確的生日。");
    if (!/^\+?\d{8,15}$/.test(phone)) throw new ApiError(400,"INVALID_PHONE","請填寫正確的電話。");
    if (member.membership_status !== "active") {
      if (body.accepted !== true) throw new ApiError(400,"TERMS_CONSENT_REQUIRED","請閱讀並勾選同意會員條款。");
      // Rollback to pre-OA-enforcement join behavior; verified LINE identity and terms remain required.
    }
    const joined = await supabase.rpc("accept_membership_terms",{
      p_line_user_id:identity.lineUserId,p_terms_id:body.termsId,p_version:body.termsVersion,
      p_accepted:body.accepted === true,p_birthday:birthday,p_phone:phone,
      p_surname:asText(body.surname,40),p_salutation:asText(body.salutation,10),
    });
    if (joined.error) throw mapDatabaseError(joined.error);
    const result = await supabase.from("members").update({
      birthday,
      phone,
      membership_status: "active",
      joined_at: member.joined_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id",member.id).select("*").single();
    if (result.error) throw mapDatabaseError(result.error);
    await supabase.from("audit_logs").insert({
      audit_id: requestId("AUD"), actor_line_user_id: identity.lineUserId, actor_role:"member",
      action,target_type:"member",target_id:identity.lineUserId,result:"success",
    });
    return { profile: await profileFor(supabase,result.data) };
  }

  if (action === "user.booking.benefits") {
    const member = await requireJoinedMember(supabase, identity);
    const profile = await profileFor(supabase, member);
    let currentBookingId = asText(body.bookingId, 60);
    if (currentBookingId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(currentBookingId)) {
        throw new ApiError(400, "INVALID_BOOKING_ID", "預約識別格式不正確。");
      }
      const booking = await supabase.from("bookings")
        .select("id,status")
        .eq("id", currentBookingId)
        .eq("member_id", member.id)
        .maybeSingle();
      if (booking.error) throw mapDatabaseError(booking.error);
      if (!booking.data) throw new ApiError(404, "BOOKING_NOT_FOUND", "找不到這筆預約。");
      if (!["pending","confirmed"].includes(String(booking.data.status || ""))) {
        throw new ApiError(409, "BOOKING_NOT_EDITABLE", "這筆預約目前無法修改票券。");
      }
      currentBookingId = String(booking.data.id);
    }
    return await loadBookingBenefits(
      supabase,
      member,
      String(profile.tierKey || "general"),
      taipeiDate(),
      currentBookingId,
    );
  }

  if (action === "user.booking.event-ticket.claim") {
    await requireJoinedMember(supabase, identity);
    const eventTicketId = requireText(body.eventTicketId, "活動票券識別", 120);
    const rpc = await supabase.rpc("claim_event_ticket", {
      p_line_user_id: identity.lineUserId,
      p_event_ticket_id: eventTicketId,
    });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    const claimId = String((rpc.data as Json)?.claimId || "");
    const claimRes = await supabase.from("event_ticket_claims")
      .select("*,event_tickets(event_ticket_id)")
      .eq("claim_id", claimId)
      .single();
    if (claimRes.error) throw mapDatabaseError(claimRes.error);
    return {
      ticket: claimClient(claimRes.data, claimRes.data.event_tickets?.event_ticket_id || eventTicketId),
      alreadyClaimed: Boolean((rpc.data as Json)?.alreadyClaimed),
    };
  }

  if (action.startsWith("user.pointcard.")) {
    const member = await requireJoinedMember(supabase,identity);
    if (action === "user.pointcard.bootstrap") return await pointBootstrap(supabase,member);
    if (action === "user.pointcard.detail") {
      const snapshot = await pointBootstrap(supabase,member);
      const cardId = asText(body.cardId,100);
      return { detail: (snapshot.cardDetails as Json)?.[cardId] || null };
    }
    if (action === "user.pointcard.ticket.redeem") {
      const ticketId = requireText(body.ticketId,"票券識別",120);
      const location = body.location && typeof body.location === "object" && !Array.isArray(body.location)
        ? body.location as Json : null;
      const rpc = await supabase.rpc("redeem_member_tickets_for_booking_request", {
        p_line_user_id: identity.lineUserId, p_booking_id: ticketBookingId(body.bookingId, (status, code, message) => new ApiError(status, code, message)),
        p_kind: "points", p_refs: [ticketId], p_request_id: asText(body.requestId, 120) || "SINGLE_" + crypto.randomUUID().replaceAll("-", ""), p_location: location,
      });
      if (rpc.error) throw mapDatabaseError(rpc.error);
      const ticketRes = await supabase.from("point_tickets").select("*,point_cards(card_id,title)").eq("ticket_id",ticketId).single();
      if (ticketRes.error) throw mapDatabaseError(ticketRes.error);
      const row:any = ticketRes.data;
      const balanceRes = await supabase.from("point_balances").select("*").eq("member_id",member.id).eq("point_card_id",row.point_card_id).single();
      if (balanceRes.error) throw mapDatabaseError(balanceRes.error);
      const nextRes = await supabase.from("point_tickets").select("*").eq("member_id",member.id).eq("point_card_id",row.point_card_id).eq("status","available").order("created_at",{ ascending:false });
      if (nextRes.error) throw mapDatabaseError(nextRes.error);
      const cardId = row.point_cards?.card_id || "";
      const ticket = pointTicketClient(row,cardId);
      const activity = {
        activityId:"point-ticket:" + row.ticket_id, referenceId:row.ticket_id, ticketId:row.ticket_id,
        ticketType:row.ticket_type,ticketTitle:row.ticket_title,cardTitle:row.point_cards?.title || "集點卡",
        pointsSpent:Number(row.points_spent || row.threshold_stamps),result:row.result || null,occurredAt:row.used_at || row.updated_at,
      };
      return {
        ticket,
        balance:{ cardId,stamps:Number(balanceRes.data.stamps || 0),updatedAt:balanceRes.data.updated_at },
        nextTickets:(nextRes.data || []).map((item:any) => pointTicketClient(item,cardId)),
        activity,
      };
    }
  }

  if (action.startsWith("user.event.")) {
    const member = await requireJoinedMember(supabase,identity);
    if (action === "user.event.bootstrap") return await eventBootstrap(supabase,member);
    if (action === "user.event.ticket.detail") {
      const snapshot:any = await eventBootstrap(supabase,member);
      const eventTicketId = asText(body.eventTicketId,100);
      return { offer:[...(snapshot.offers || []),...(snapshot.usedTickets || [])].find((offer:any) => String(offer.ticket?.eventTicketId || offer.claim?.eventTicketId) === eventTicketId) || null };
    }
    if (action === "user.event.ticket.claim") {
      const eventTicketId = requireText(body.eventTicketId,"活動票券識別",120);
      const rpc = await supabase.rpc("claim_event_ticket",{ p_line_user_id:identity.lineUserId,p_event_ticket_id:eventTicketId });
      if (rpc.error) throw mapDatabaseError(rpc.error);
      const claimId = String((rpc.data as Json)?.claimId || "");
      const claimRes = await supabase.from("event_ticket_claims").select("*,event_tickets(event_ticket_id)").eq("claim_id",claimId).single();
      if (claimRes.error) throw mapDatabaseError(claimRes.error);
      return { ticket:claimClient(claimRes.data,claimRes.data.event_tickets?.event_ticket_id || eventTicketId),alreadyClaimed:Boolean((rpc.data as Json)?.alreadyClaimed) };
    }
    if (action === "user.event.ticket.redeem") {
      const claimId = requireText(body.claimId,"已領取票券識別",120);
      const location = body.location && typeof body.location === "object" && !Array.isArray(body.location)
        ? body.location as Json : null;
      const rpc = await supabase.rpc("redeem_member_tickets_for_booking_request", {
        p_line_user_id: identity.lineUserId, p_booking_id: ticketBookingId(body.bookingId, (status, code, message) => new ApiError(status, code, message)),
        p_kind: "event", p_refs: [claimId], p_request_id: asText(body.requestId, 120) || "SINGLE_" + crypto.randomUUID().replaceAll("-", ""), p_location: location,
      });
      if (rpc.error) throw mapDatabaseError(rpc.error);
      const claimRes = await supabase.from("event_ticket_claims").select("*,event_tickets(event_ticket_id)").eq("claim_id",claimId).single();
      if (claimRes.error) throw mapDatabaseError(claimRes.error);
      return { ticket:claimClient(claimRes.data,claimRes.data.event_tickets?.event_ticket_id || "") };
    }
  }

  if (action.startsWith("user.calendar.")) {
    const member = await requireJoinedMember(supabase,identity);
    const [profile,items] = await Promise.all([
      profileFor(supabase,member),
      calendarItems(supabase,true),
    ]);
    const policy=await loadVisibilityPolicy(supabase);
    const visibleItems=items.flatMap((item:any)=>{const v=tierVisibility(item.allowedTierKeys,profile.tierKey,policy);return item.itemType==='holiday'?[item]:v.visible?[{...item,...v}]:[];});
    if (action === "user.calendar.bootstrap") return { profile,items:visibleItems };
    const date = asText(body.date,20);
    return { profile,items:visibleItems.filter((item:any) => item.startsOn <= date && (item.endsOn || item.startsOn) >= date) };
  }

  if (!action.startsWith("admin.")) throw new ApiError(404,"ACTION_NOT_FOUND","不支援的 API action。");
  const admin = await authorizeAdmin(supabase,identity);
  if (action === "admin.bootstrap") {
    // Share only within this authorized request; never cache member data globally.
    const settings = tierSettings(supabase);
    const [members,tierRows,cardData,eventTickets,calendar,stats,messagePresets,bookingServices] = await Promise.all([
      membersPage(supabase,1,100,"","real",settings),
      settings,
      adminCards(supabase),
      adminEventTickets(supabase),
      calendarItems(supabase,false),
      summaryStats(supabase),
      grantMessagePresets(supabase,true),
      bookingServiceOptions(supabase),
    ]);
    return {
      profile:{ displayName:admin.display_name || identity.displayName },
      role:"Admin",
      members:members.members,
      memberPage:members.memberPage,
      tierSettings:tierSettingsClient(tierRows),
      cards:cardData.cards,
      tickets:cardData.tickets,
      eventTickets,
      calendarItems:calendar,
      messagePresets,
      bookingServices,
      bookingServiceTypes:[...new Set(bookingServices.map((service) => service.serviceType).filter(Boolean))],
      stats,
    };
  }
  if (action === "admin.terms.list") {
    const result = await supabase.from("membership_terms").select("*").order("created_at",{ ascending:false });
    if (result.error) throw mapDatabaseError(result.error);
    return { terms:result.data || [] };
  }
  if (action === "admin.terms.draft.save") {
    const result = await supabase.rpc("save_membership_terms_draft",{
      p_actor:identity.lineUserId,p_id:body.id || null,p_version:body.version,
      p_title:body.title,p_summary:body.summary,p_body:body.body,
      p_required:body.required === true,p_effective_at:body.effectiveAt,
      p_reconsent_existing:body.reconsentExisting === true,
    });
    if (result.error) throw mapDatabaseError(result.error);
    return { id:result.data };
  }
  if (action === "admin.terms.activate") {
    const result = await supabase.rpc("activate_membership_terms",{
      p_actor:identity.lineUserId,p_id:body.id,
    });
    if (result.error) throw mapDatabaseError(result.error);
    return { id:result.data };
  }
  if (action === "admin.members.list") {
    return await membersPage(supabase,Number(body.memberPage || 1),Number(body.memberPageSize || 100),asText(body.memberQuery,100),asText(body.memberKind,10));
  }
  if (action === "admin.members.presence.list") {
    const lineUserIds = Array.isArray(body.lineUserIds) ? body.lineUserIds.map((value) => asText(value,120)).filter(Boolean) : [];
    return await memberPresenceForLineUserIds(supabase,lineUserIds);
  }
  if (action === "admin.member-records.list") {
    return await adminMemberRecords(supabase,requireText(body.lineUserId,"會員識別",120));
  }
  if (action === "admin.member.remove") {
    await authorizeAdmin(supabase, identity);
    return await removeMember(supabase, identity.lineUserId, body, (status, code, message) => new ApiError(status, code, message)) as Json;
  }
  if (action === "admin.member.force-logout") {
    const lineUserId = requireText(body.lineUserId,"會員識別",120);
    const target = await supabase.from("members").select("id,line_user_id,display_name").eq("line_user_id",lineUserId).maybeSingle();
    if (target.error) throw mapDatabaseError(target.error);
    if (!target.data) throw new ApiError(404,"MEMBER_NOT_FOUND","找不到指定會員。");

    const revokedAt = new Date().toISOString();
    const updated = await supabase.from("members")
      .update({ force_logout_after:revokedAt,updated_at:revokedAt })
      .eq("id",target.data.id);
    if (updated.error) throw mapDatabaseError(updated.error);

    const [presenceResult,testSessionResult] = await Promise.all([
      supabase.from("member_presence_sessions")
        .update({ last_seen_at:revokedAt,offline_at:revokedAt,offline_reason:"admin_force_logout",updated_at:revokedAt })
        .eq("member_id",target.data.id)
        .is("offline_at",null),
      supabase.from("test_login_sessions")
        .update({ revoked_at:revokedAt,revoked_reason:"admin_force_logout",last_used_at:revokedAt })
        .eq("member_id",target.data.id)
        .is("revoked_at",null),
    ]);
    if (presenceResult.error) throw mapDatabaseError(presenceResult.error);
    if (testSessionResult.error) throw mapDatabaseError(testSessionResult.error);

    const auditResult = await supabase.from("audit_logs").insert({
      audit_id:requestId("AUD"),
      actor_line_user_id:identity.lineUserId,
      actor_role:admin.role || "admin",
      action:"MEMBER_FORCE_LOGOUT",
      target_type:"member",
      target_id:lineUserId,
      result:"success",
      detail:{ revokedAt },
    });
    if (auditResult.error) throw mapDatabaseError(auditResult.error);

    await supabase.from("realtime_events").insert(
      ["member","points","event","calendar","booking","admin"].map((scope) => ({ scope,event_type:"admin.member.force-logout" })),
    );
    return { lineUserId,revokedAt };
  }
  if (action === "admin.settings.copy") {
    const result=await supabase.rpc("copy_admin_settings",{p_actor:identity.lineUserId,p_kind:asText(body.kind,20),p_source:asText(body.sourceId,120),p_title:asText(body.title,101),p_request_id:asText(body.requestId,120)});
    if(result.error) throw mapDatabaseError(result.error);
    return result.data as Json;
  }
  if (action === "admin.ticket-visibility.get") {
    const r=await supabase.from("event_ticket_settings").select("visibility_policy,updated_at").eq("id",1).single();
    if(r.error) throw mapDatabaseError(r.error);
    return {visibilityPolicy:r.data.visibility_policy,updatedAt:r.data.updated_at};
  }
  if (action === "admin.ticket-visibility.save") {
    const policy=asText(body.visibilityPolicy,40);
    if(!["eligible_only","higher_preview"].includes(policy)) throw new ApiError(400,"INVALID_VISIBILITY_POLICY","可見性設定不正確。");
    const r=await supabase.from("event_ticket_settings").update({visibility_policy:policy,updated_by:identity.lineUserId,updated_at:new Date().toISOString()}).eq("id",1).eq("updated_at",asText(body.expectedUpdatedAt,100)).select("updated_at").maybeSingle();
    if(r.error) throw mapDatabaseError(r.error);
    if(!r.data) throw new ApiError(409,"CONFLICT","設定已更新，請重新整理後再試。");
    await supabase.from("audit_logs").insert({audit_id:requestId("AUD"),actor_line_user_id:identity.lineUserId,actor_role:admin.role,action:"TICKET_VISIBILITY_UPDATED",target_type:"event_ticket_settings",target_id:"1",result:"success",detail:{policy}});
    await supabase.from("realtime_events").insert(["event","booking","calendar","admin"].map(scope=>({scope,event_type:action})));
    return {visibilityPolicy:policy,updatedAt:r.data.updated_at};
  }
  if (action === "admin.pointcards.list") {
    const [data,bookingServices,stats] = await Promise.all([
      adminCards(supabase),
      bookingServiceOptions(supabase),
      summaryStats(supabase),
    ]);
    return { ...data,bookingServices,bookingServiceTypes:[...new Set(bookingServices.map((service) => service.serviceType).filter(Boolean))],stats };
  }
  if (action === "admin.event-tickets.list") {
    const [eventTickets,bookingServices,stats] = await Promise.all([
      adminEventTickets(supabase),
      bookingServiceOptions(supabase),
      summaryStats(supabase),
    ]);
    return { eventTickets,bookingServices,bookingServiceTypes:[...new Set(bookingServices.map((service) => service.serviceType).filter(Boolean))],stats };
  }
  if (action === "admin.calendar-items.list") return { calendarItems:await calendarItems(supabase,false) };
  if (action === "admin.summary") return { stats:await summaryStats(supabase) };
  if (action === "admin.integration-overview") return await adminIntegrationOverview(supabase);

  if (action === "admin.grant-message-presets.save") {
    const preset = body.messagePreset && typeof body.messagePreset === "object" ? body.messagePreset as Json : {};
    const presetId = asText(preset.presetId,120);
    const title = requireText(preset.title,"預設訊息名稱",80);
    const message = requireText(preset.message,"預設訊息內容",1000);
    const status = asText(preset.status,20);
    if (!["active","archived"].includes(status)) throw new ApiError(400,"INVALID_MESSAGE_PRESET_STATUS","預設訊息狀態不合法。");
    const sortOrder = Number(preset.sortOrder || 0);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) throw new ApiError(400,"INVALID_MESSAGE_PRESET_SORT","預設訊息排序不合法。");
    const now = new Date().toISOString();
    let savedPresetId = presetId;
    if (presetId) {
      const current = await supabase.from("grant_message_presets").select("*").eq("preset_id",presetId).single();
      if (current.error) throw new ApiError(404,"MESSAGE_PRESET_NOT_FOUND","找不到指定預設訊息。");
      const expected = asText(body.expectedUpdatedAt,100);
      if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","預設訊息已被其他管理者更新。");
      const updated = await supabase.from("grant_message_presets").update({
        title,message,status,sort_order:sortOrder,updated_by:identity.lineUserId,updated_at:now,
      }).eq("id",current.data.id);
      if (updated.error) throw mapDatabaseError(updated.error);
    } else {
      savedPresetId = "GMP-" + crypto.randomUUID().replaceAll("-","").slice(0,16).toUpperCase();
      const inserted = await supabase.from("grant_message_presets").insert({
        preset_id:savedPresetId,title,message,status,sort_order:sortOrder,
        created_by:identity.lineUserId,updated_by:identity.lineUserId,created_at:now,updated_at:now,
      });
      if (inserted.error) throw mapDatabaseError(inserted.error);
    }
    await supabase.from("audit_logs").insert({
      audit_id:requestId("AUD"),
      actor_line_user_id:identity.lineUserId,
      actor_role:admin.role || "admin",
      action:"GRANT_MESSAGE_PRESET_SAVE",
      target_type:"grant_message_preset",
      target_id:savedPresetId,
      result:"success",
      detail:{ status,sortOrder },
    });
    const messagePresets = await grantMessagePresets(supabase,true);
    return { messagePreset:messagePresets.find((item:any) => item.presetId === savedPresetId) || null,messagePresets };
  }

  if (action === "admin.member.update") {
    const lineUserId = requireText(body.lineUserId,"會員識別",120);
    const status = asText(body.status,20);
    if (!["active","disabled"].includes(status)) throw new ApiError(400,"INVALID_STATUS","會員狀態不合法。");
    const current = await supabase.from("members").select("*").eq("line_user_id",lineUserId).single();
    if (current.error) throw new ApiError(404,"MEMBER_NOT_FOUND","找不到指定會員。");
    if (current.data?.is_test_account === true) throw new ApiError(410,"TEST_MEMBERS_RETIRED","測試會員功能已移除。");
    if (body.profile != null) throw new ApiError(400,"PROFILE_EDIT_FORBIDDEN","管理端不得修改會員私人基本資料。");
    const expected = asText(body.expectedUpdatedAt,100);
    if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","會員資料已被其他管理者更新。");

    const patch: Record<string, unknown> = { status,updated_at:new Date().toISOString() };
    const profile = body.profile && typeof body.profile === "object" ? body.profile as Json : null;
    if (current.data.is_test_account === true && profile) {
      const displayName = requireText(profile.displayName,"顯示名稱",80);
      const surname = requireText(profile.surname,"姓氏",40);
      const salutation = asText(profile.salutation,10).toLowerCase();
      const birthday = asText(profile.birthday,20);
      const phone = asText(profile.phone,30).replace(/[()\s-]/g,"");
      if (!["mr","ms"].includes(salutation)) throw new ApiError(400,"INVALID_SALUTATION","請選擇先生或小姐。");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || Number.isNaN(Date.parse(`${birthday}T00:00:00Z`))) throw new ApiError(400,"INVALID_BIRTHDAY","請填寫正確的生日。");
      if (!/^\+?\d{8,15}$/.test(phone)) throw new ApiError(400,"INVALID_PHONE","請填寫正確的電話。");
      Object.assign(patch,{ display_name:displayName,surname,salutation,birthday,phone,membership_status:"active" });
    } else if (current.data.is_test_account !== true && profile) {
      throw new ApiError(400,"TEST_PROFILE_ONLY","只有測試用戶可由管理端修改虛擬個人資料。");
    }

    const updated = await supabase.from("members").update(patch).eq("id",current.data.id).select("*").single();
    if (updated.error) throw mapDatabaseError(updated.error);
    await supabase.from("audit_logs").insert({
      audit_id:requestId("AUD"),
      actor_line_user_id:identity.lineUserId,
      actor_role:admin.role || "admin",
      action:"ADMIN_MEMBER_UPDATE",
      target_type:"member",
      target_id:updated.data.line_user_id,
      result:"success",
      detail:{ status,profileFields:Object.keys(patch).filter(key=>key!=="updated_at" && current.data[key]!==updated.data[key]),isTestAccount:updated.data.is_test_account === true,profileUpdated:Boolean(profile && updated.data.is_test_account === true) },
    });
    const settings = await tierSettings(supabase);
    const totals = await serviceMinutesForMembers(supabase,[updated.data.id]);
    const minutes = totals.get(updated.data.id) || 0;
    const tier = tierForMinutes(settings,minutes);
    return { member:{ lineUserId:updated.data.line_user_id,displayName:updated.data.display_name,memberCode:updated.data.member_code,status:updated.data.status,membershipStatus:updated.data.membership_status,birthday:updated.data.birthday || "",phone:updated.data.phone || "",surname:updated.data.surname || "",salutation:updated.data.salutation || "",isTestAccount:updated.data.is_test_account === true,testAccountSequence:updated.data.test_account_sequence || null,joinedAt:updated.data.joined_at || updated.data.created_at,serviceMinutesTotal:minutes,tierKey:tier.tier_key,tier:tier.tier_label,tierStyleKey:tier.style_key,updatedAt:updated.data.updated_at } };
  }

  if (action === "admin.member-tiers.save") {
    if (!Array.isArray(body.tierSettings)) throw new ApiError(400,"INVALID_TIER_SETTINGS","會員等級設定格式不正確。");
    const rpc = await supabase.rpc("save_tier_settings",{ p_actor_line_user_id:identity.lineUserId,p_settings:body.tierSettings });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    return { tierSettings:tierSettingsClient(await tierSettings(supabase)) };
  }

  if (action === "admin.pointcards.save") {
    const card = body.card && typeof body.card === "object" ? body.card as Json : {};
    requireText(card.title,"集點卡名稱",100);
    requireStatus(card.status);
    requireAccent(card.accent);
    const expiryMode = asText(card.expiryMode,20);
    if (!["unlimited","date"].includes(expiryMode)) throw new ApiError(400,"INVALID_EXPIRY","集點卡期限設定不正確。");
    if (expiryMode === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(asText(card.expiresOn,20))) throw new ApiError(400,"INVALID_EXPIRY","請選擇有效的到期日。");
    const rewards = Array.isArray(card.rewards) ? card.rewards as Json[] : [];
    const thresholds = new Set<number>();
    const normalizedRewards: Json[] = [];
    for (const reward of rewards) {
      const threshold = Number(reward.thresholdStamps);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100 || thresholds.has(threshold)) throw new ApiError(400,"INVALID_REWARD","兌換節點必須是 1–100 且不可重複。");
      thresholds.add(threshold);
      const ticketTemplateId = requireText(reward.ticketTemplateId,"兌換票券",120);
      const requiredServiceIds = reward.requiredServiceIds !== undefined
        ? await normalizeRequiredServiceIds(supabase,reward.requiredServiceIds)
        : await serviceIdsForLegacyTypes(supabase,reward.requiredServiceTypes);
      const groupMode = reward.requiredServiceMatchMode === "groups";
       const requiredServiceGroups = groupMode ? await normalizeRequiredServiceGroups(supabase,reward.requiredServiceGroups) : [];
       if (groupMode && !requiredServiceGroups.length) throw new ApiError(400,"INVALID_REQUIRED_SERVICE_GROUPS","請至少設定一個有效的預約組合。");
       const requiredServiceMatchMode = reward.requiredServiceMatchMode === "all" ? "all" : "any";
       normalizedRewards.push({ ...reward,thresholdStamps:threshold,ticketTemplateId,requiredServiceIds: groupMode ? [] : requiredServiceIds,requiredServiceMatchMode,requiredServiceGroups });
    }
    const normalized = { ...card,title:asText(card.title,100),status:asText(card.status,20),accent:requireAccent(card.accent),styleKey:safePointCardStyle(card.styleKey),expiryMode,expiresOn:expiryMode === "date" ? asText(card.expiresOn,20) : "",usageMethod:asText(card.usageMethod,120),usageInstructions:asText(card.usageInstructions,500),benefitDescription:asText(card.benefitDescription,500),rewards:normalizedRewards };
    const rpc = await supabase.rpc("save_point_card_service_items",{ p_actor_line_user_id:identity.lineUserId,p_card:normalized,p_expected_updated_at:asText(body.expectedUpdatedAt,100) || null });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    const cards = await adminCards(supabase);
    return { card:cards.cards.find((item:any) => item.cardId === rpc.data) || null };
  }

  if (action === "admin.pointcards.reorder") {
    if (!Array.isArray(body.cardOrders)) throw new ApiError(400,"INVALID_CARD_ORDERS","排序資料格式不正確。");
    const rpc = await supabase.rpc("reorder_point_cards",{ p_actor_line_user_id:identity.lineUserId,p_orders:body.cardOrders });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    return { cards:(await adminCards(supabase)).cards };
  }

  if (action === "admin.pointcards.archive" || action === "admin.pointcards.remove") {
    const cardId = requireText(body.cardId,"集點卡識別",120);
    const current = await supabase.from("point_cards").select("*").eq("card_id",cardId).single();
    if (current.error) throw new ApiError(404,"POINT_CARD_NOT_FOUND","找不到指定集點卡。");
    const expected = asText(body.expectedUpdatedAt,100);
    if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","集點卡已被其他管理者更新。");
    const result = await supabase.from("point_cards").update({ status:"archived",updated_by:identity.lineUserId,updated_at:new Date().toISOString() }).eq("id",current.data.id);
    if (result.error) throw mapDatabaseError(result.error);
    return { card:(await adminCards(supabase)).cards.find((item:any) => item.cardId === cardId) || null };
  }

  if (action === "admin.pointcards.delete") {
    const cardId = requireText(body.cardId,"集點卡識別",120);
    const current = await supabase.from("point_cards").select("*").eq("card_id",cardId).single();
    if (current.error) throw new ApiError(404,"POINT_CARD_NOT_FOUND","找不到指定集點卡。");
    const expected = asText(body.expectedUpdatedAt,100);
    if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","集點卡已被其他管理者更新。");
    const rpc = await supabase.rpc("delete_point_card",{ p_actor_line_user_id:identity.lineUserId,p_card_id:cardId });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    return { deleted:true,cardId };
  }

  if (action === "admin.tickets.save") return await saveTicketTemplate(supabase,identity.lineUserId,body);
  if (action === "admin.tickets.delete") {
    const ticketTemplateId = requireText(body.ticketTemplateId,"票券識別",100);
    const expectedUpdatedAt = requireText(body.expectedUpdatedAt,"票券資料版本",100);
    const removed = await supabase.rpc("delete_point_ticket_template", {
      p_actor_line_user_id: identity.lineUserId,
      p_ticket_template_id: ticketTemplateId,
      p_expected_updated_at: expectedUpdatedAt,
    });
    if (removed.error) throw mapDatabaseError(removed.error);
    return removed.data as Json;
  }

  if (action === "admin.event-tickets.save") return await saveEventTicket(supabase,identity.lineUserId,body);

  if (action === "admin.event-tickets.delete") {
    const eventTicketId = requireText(body.eventTicketId,"活動票券識別",120);
    const current = await supabase.from("event_tickets").select("*").eq("event_ticket_id",eventTicketId).is("deleted_at",null).single();
    if (current.error) throw new ApiError(404,"EVENT_TICKET_NOT_FOUND","找不到指定活動票券。");
    const expected = asText(body.expectedUpdatedAt,100);
    if (expected && expected !== current.data.updated_at) throw new ApiError(409,"CONFLICT","活動票券已被其他管理者更新。");
    const claims = await supabase.from("event_ticket_claims").select("*",{ count:"exact",head:true }).eq("event_ticket_id",current.data.id);
    if (claims.error) throw mapDatabaseError(claims.error);
    const update = await supabase.from("event_tickets").update({ status:"archived",deleted_at:new Date().toISOString(),updated_by:identity.lineUserId,updated_at:new Date().toISOString() }).eq("id",current.data.id);
    if (update.error) throw mapDatabaseError(update.error);
    return { deleted:true,eventTicketId,preservedClaimCount:claims.count || 0 };
  }

  if (action === "admin.calendar-items.save") {
    const item = body.calendarItem && typeof body.calendarItem === "object" ? body.calendarItem as Json : {};
    const rpc = await supabase.rpc("apply_calendar_batch",{ p_actor_line_user_id:identity.lineUserId,p_operations:[{ action:"save",calendarItem:item,expectedUpdatedAt:body.expectedUpdatedAt || "" }] });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    const id = String((rpc.data as any[])?.[0]?.calendarItemId || "");
    return { calendarItem:(await calendarItems(supabase,false)).find((entry:any) => entry.calendarItemId === id) || null };
  }
  if (action === "admin.calendar-items.delete") {
    const id = requireText(body.calendarItemId,"日曆項目識別",120);
    const rpc = await supabase.rpc("apply_calendar_batch",{ p_actor_line_user_id:identity.lineUserId,p_operations:[{ action:"delete",calendarItemId:id,expectedUpdatedAt:body.expectedUpdatedAt || "" }] });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    return { deleted:true,calendarItemId:id };
  }
  if (action === "admin.calendar-items.batch") {
    if (!Array.isArray(body.calendarItemOperations)) throw new ApiError(400,"INVALID_CALENDAR_BATCH","日曆批次操作格式不正確。");
    const rpc = await supabase.rpc("apply_calendar_batch",{ p_actor_line_user_id:identity.lineUserId,p_operations:body.calendarItemOperations });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    return { operations:rpc.data || [],calendarItems:await calendarItems(supabase,false) };
  }

  if (action === "admin.service-grants.catalog" || action === "admin.service-grants.preview") {
    const rpc = action.endsWith("catalog")
      ? await supabase.rpc("admin_service_grant_catalog", { p_actor:identity.lineUserId })
      : await supabase.rpc("preview_service_member_grant", { p_actor:identity.lineUserId,p_member:requireText(body.lineUserId,"會員識別",120),p_items:body.items });
    if (rpc.error) throw mapDatabaseError(rpc.error);
    return action.endsWith("catalog") ? rpc.data : { preview:rpc.data };
  }

  if (action === "admin.service-grants.add" || action === "admin.member-grants.add" || action === "admin.stamps.add" || action === "admin.service_minutes.add") {
    const lineUserId = requireText(body.lineUserId,"會員識別",120);
    const req = requireText(body.requestId,"操作識別碼",100);
    const targetMember = await supabase.from("members").select("*").eq("line_user_id",lineUserId).single();
    if (targetMember.error) throw new ApiError(404,"MEMBER_NOT_FOUND","找不到指定會員。");
    const isTestAccount = targetMember.data.is_test_account === true;
    const messagePresetId = asText(body.messagePresetId,120);
    let selectedMessagePreset: any = null;
    if (messagePresetId && !isTestAccount) {
      const presetResult = await supabase.from("grant_message_presets").select("*").eq("preset_id",messagePresetId).eq("status","active").maybeSingle();
      if (presetResult.error) throw mapDatabaseError(presetResult.error);
      if (!presetResult.data) throw new ApiError(400,"MESSAGE_PRESET_NOT_AVAILABLE","選擇的預設訊息目前無法使用。");
      selectedMessagePreset = presetResult.data;
    }
    let normalizedPoints: Json[] = [];
    let serviceMinutes: number | null = null;
    let serviceGrantRpc: any = null;
    if (action === "admin.service-grants.add") {
      if (body.points !== undefined || body.serviceTime !== undefined) throw new ApiError(400,"INVALID_SERVICE_ITEMS","服務項目模式不可指定點數或服務分鐘。");
      serviceGrantRpc = await supabase.rpc("grant_service_member_benefits", {
        p_actor:identity.lineUserId,p_member:lineUserId,p_request:req,p_items:body.items,p_expected_preview:body.expectedPreview,
      });
      if (serviceGrantRpc.error) throw mapDatabaseError(serviceGrantRpc.error);
      const preview = serviceGrantRpc.data?.preview;
      normalizedPoints = Array.isArray(preview?.points) ? preview.points : [];
      serviceMinutes = Number(preview?.serviceMinutes || 0) || null;
    } else if (action === "admin.stamps.add") {
      const amount = Number(body.amount);
      const cardId = asText(body.cardId,120);
      if (!cardId || !Number.isInteger(amount) || amount < 1 || amount > 100) {
        throw new ApiError(400,"INVALID_POINT_AMOUNT","點數必須是 1–100 的整數。");
      }
      normalizedPoints = [{ cardId, amount }];
    } else if (action === "admin.service_minutes.add") {
      const minutes = Number(body.minutes ?? (body.serviceTime as Json)?.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        throw new ApiError(400,"INVALID_SERVICE_MINUTES","服務時間必須是 1–1440 分鐘。");
      }
      serviceMinutes = minutes;
    } else {
      if (body.points !== undefined) {
        if (!Array.isArray(body.points)) {
          throw new ApiError(400,"INVALID_POINT_AMOUNT","點數發放格式不正確。");
        }
        const seenCards = new Set<string>();
        normalizedPoints = body.points.map((raw:any) => {
          const cardId = asText(raw?.cardId,120);
          const amount = Number(raw?.amount);
          if (!cardId || !Number.isInteger(amount) || amount < 1 || amount > 100 || seenCards.has(cardId)) {
            throw new ApiError(400,"INVALID_POINT_AMOUNT","每張集點卡只能出現一次，點數必須是 1–100 的整數。");
          }
          seenCards.add(cardId);
          return { cardId, amount };
        });
      }

      const hasServiceTime = Boolean(body.serviceTime && typeof body.serviceTime === "object"
        && Object.prototype.hasOwnProperty.call(body.serviceTime as Json,"minutes"));
      if (hasServiceTime) {
        const minutes = Number((body.serviceTime as Json).minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          throw new ApiError(400,"INVALID_SERVICE_MINUTES","服務時間必須是 1–1440 分鐘。");
        }
        serviceMinutes = minutes;
      }

      if (!normalizedPoints.length && serviceMinutes === null) {
        throw new ApiError(400,"EMPTY_GRANT","請至少發放一項點數或服務時間。");
      }
    }

    const rpc = serviceGrantRpc || await supabase.rpc("grant_member_benefits",{
      p_actor_line_user_id:identity.lineUserId,
      p_member_line_user_id:lineUserId,
      p_request_id:req,
      p_points:normalizedPoints.length ? normalizedPoints : null,
      p_service_minutes:serviceMinutes,
      p_note:"",
    });
    if (rpc.error) throw mapDatabaseError(rpc.error);

    const grantResult = (rpc.data && typeof rpc.data === "object" ? rpc.data : {}) as Json;
    const memberRow = targetMember;
    const settings = await tierSettings(supabase);
    const totals = await serviceMinutesForMembers(supabase,[memberRow.data.id]);
    const minutes = totals.get(memberRow.data.id)||0;
    const tier = tierForMinutes(settings,minutes);

    let notification: GrantNotificationResult = isTestAccount
      ? { status:"skipped",message:"測試用戶不發送 LINE 通知。" }
      : { status:"skipped",message:"此操作已處理，不重複發送 LINE 通知。" };
    if (Boolean(grantResult.applied) && !isTestAccount) {
      try {
        notification = await pushGrantNotification(
          supabase,
          lineUserId,
          memberRow.data.display_name || "會員",
          memberRow.data.id,
          req,
          normalizedPoints,
          serviceMinutes || 0,
          selectedMessagePreset?.message || "",
          minutes,
          tier.tier_key,
          tier.tier_label,
        );
      } catch {
        notification = { status:"failed",message:"發放已成功，但 LINE 推播處理失敗。" };
      }
    }

    return {
      member:{ lineUserId,displayName:memberRow.data.display_name,memberCode:memberRow.data.member_code,status:memberRow.data.status,membershipStatus:memberRow.data.membership_status,birthday:memberRow.data.birthday || "",phone:memberRow.data.phone || "",surname:memberRow.data.surname || "",salutation:memberRow.data.salutation || "",isTestAccount,testAccountSequence:memberRow.data.test_account_sequence || null,joinedAt:memberRow.data.joined_at || memberRow.data.created_at,serviceMinutesTotal:minutes,tierKey:tier.tier_key,tier:tier.tier_label,tierStyleKey:tier.style_key,updatedAt:memberRow.data.updated_at },
      notification,
      ...(serviceGrantRpc ? { grant:grantResult } : {}),
    };
  }

  throw new ApiError(404,"ACTION_NOT_FOUND","不支援的 API action。");
}

async function handleRequest(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (origin && !allowedOrigins().has(origin)) throw new ApiError(403,"ORIGIN_NOT_ALLOWED","此網站來源未被允許使用會員 API。");
    if (request.method === "OPTIONS") return new Response(null,{ status:204,headers:corsHeaders(origin) });
    if (request.method === "GET") return json(origin,{ ok:true,status:200,data:{ service:"MemberWebsocket Supabase Native",version:"1.0.0" } });
    if (request.method !== "POST") throw new ApiError(405,"METHOD_NOT_ALLOWED","不支援的 HTTP method。");

    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);

    const action = asText(body.action,80);
    const requestedClientType = asText(body.clientType,20);
    const idToken = asText(body.idToken,10000);
    const testSessionToken = asText(body.testSessionToken,200);
    if (!action) throw new ApiError(400,"INVALID_ACTION","API action 不合法。");
    const clientType = clientTypeForAction(action);
    if (requestedClientType && requestedClientType !== clientType) throw new ApiError(400,"CLIENT_TYPE_MISMATCH","Client type 與 API action 不一致。");
    if (!idToken && !(testSessionToken && clientType !== "admin")) throw new ApiError(401,"AUTH_REQUIRED","需要 LINE 登入。");

    const supabase = dbClient();
    if (clientType !== "admin") {
      const mode = await supabase.from("test_mode_settings")
        .select("maintenance_enabled,maintenance_message")
        .eq("id",true)
        .maybeSingle();
      if (mode.error) throw new ApiError(503,"TEST_MODE_CHECK_FAILED","目前無法確認系統維護狀態。");
      const maintenancePresenceEvent = presenceActionInfo(action)?.event;
      if (mode.data?.maintenance_enabled && !testSessionToken && maintenancePresenceEvent !== "offline" && maintenancePresenceEvent !== "heartbeat") {
        throw new ApiError(503,"SYSTEM_MAINTENANCE",asText(mode.data.maintenance_message,500) || "系統維護中，請稍後再試。");
      }
    }

    let identity: { lineUserId: string; displayName: string; issuedAtMs?: number };
    if (clientType !== "admin" && testSessionToken) {
      try {
        const testIdentity = await resolveTestSession(supabase,testSessionToken);
        identity = { lineUserId:testIdentity.lineUserId,displayName:testIdentity.displayName };
      } catch (error) {
        if (error instanceof TestModeAuthError) throw new ApiError(error.status,error.code,error.message);
        throw error;
      }
    } else {
      identity = await verifyLineIdToken(idToken,clientType,action.endsWith(".session.claim"));
    }
    await consumeRateLimit(supabase,identity.lineUserId,action,body);
    const data = await handleAction(supabase,identity,action,body);
    await emitRealtime(supabase,action);
    return json(origin,{ ok:true,status:200,data:data || {} },200);
  } catch (error) {
    return errorResponse(origin,error);
  }
}

export default { fetch: businessHandler('api', handleRequest) };
