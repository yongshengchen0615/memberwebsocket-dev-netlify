import { businessEnv, businessContext, serveBusiness } from '../_shared/business-runtime.ts';
import { linkedBooking } from "../_shared/linked-booking.ts";
import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { resolveTestSession, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import { createClient, SupabaseClient } from '../_shared/business-runtime.ts';
import { workWindow, clockTime, occupiedRange, localRange, slotHasPassed, timeOnBusinessDate, localTimestamp, currentBusinessDate } from "../_shared/booking-hours.ts";

type Json = Record<string, unknown>;
type Identity = { lineUserId: string; displayName: string };
type ClientType = "member" | "admin";
type RequestedItem = { serviceId: string; quantity: number; service: any };

const MAX_REQUEST_BYTES = 30_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;
const SLOT_START_INTERVAL_MINUTES = 30;
const STORE_SERVICE_ID = "00000000-0000-4000-8000-000000000010";
const TYPE_PREFIX = "__TYPE__:";
const WRITE_ACTIONS = new Set([
  "user.booking.create",
  "admin.booking.risk.save",
  "admin.booking.risk.revoke",
  "admin.booking.risk.release",
  "user.booking.cancel",
  "user.booking.update",
  "admin.booking.settings.save",
  "admin.booking.service.save",
  "admin.booking.status.update",
  "admin.booking.phone.create",
  "admin.booking.notifications.read",
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

function response(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(origin: string | null, error: unknown): Response {
  const apiError = error instanceof ApiError ? error : mapDatabaseError(error);
  return response(origin, {
    ok: false,
    status: apiError.status,
    error: { code: apiError.code, message: apiError.message, details: apiError.details },
  }, apiError.status);
}

function mapDatabaseError(error: unknown): ApiError {
  const raw = error as { message?: string; details?: string; code?: string };
  const message = `${raw?.message || ""} ${raw?.details || ""}`;
  const rules: Array<[string, number, string, string]> = [
    ["BOOKING_RESTRICTED",403,"BOOKING_RESTRICTED","目前暫停線上預約，請重新整理查看到期時間與聯絡方式。"],
    // Legacy SQL error also protects administrator revoke/release reason validation.
    ["INVALID_APPEAL_REASON",400,"INVALID_RISK_ACTION_REASON","請填寫 1–500 字的撤銷或解除原因。"],
    ["booking_no_show_policy",400,"INVALID_BOOKING_POLICY","請完整設定計次期間、門檻、限制期限、寬限與聯絡方式。"],
    ["INVALID_BOOKING_ID",400,"INVALID_BOOKING_ID","預約識別格式不正確。"],
    ["BOOKING_NO_SHOW_TOO_EARLY",409,"BOOKING_NO_SHOW_TOO_EARLY","服務結束後才能標記無故未到。"],
    ["BOOKING_NO_SHOW_NOT_ALLOWED",409,"BOOKING_NO_SHOW_NOT_ALLOWED","只有待確認的一般預約可標記無故未到，請重新整理。"],
    ["BOOKING_NOT_FOUND",404,"BOOKING_NOT_FOUND","找不到這筆預約。"],
    ["ADMIN_REQUIRED",403,"ADMIN_REQUIRED","目前沒有管理員權限。"],
    ["BOOKING_OVERLAP_ACK_REQUIRED",400,"BOOKING_OVERLAP_ACK_REQUIRED","請先確認電話預約可能與現有預約重疊。"],
    ["INVALID_BOOKING_CONTACT",400,"INVALID_BOOKING_CONTACT","請填寫客人姓氏、稱謂與有效的聯絡電話。"],
    ["INVALID_BOOKING_NOTE",400,"INVALID_BOOKING_NOTE","預約說明不得超過 500 字。"],
    ["INVALID_REQUEST_ID",400,"INVALID_REQUEST_ID","操作識別碼不正確，請重新開啟電話預約表單。"],
    ["BOOKING_CONFLICT", 409, "BOOKING_CONFLICT", "預約已被更新，請重新整理後再操作。"],
    ["BOOKING_NOT_EDITABLE", 409, "BOOKING_NOT_EDITABLE", "這筆預約已開始或狀態已變更，無法修改。"],
    ["BOOKING_CANCELLATION_PENDING", 409, "BOOKING_CANCELLATION_PENDING", "這筆預約已有待確認的取消申請，請先完成取消審核後再變更預約。"],
    ["BOOKING_NOT_CANCELLABLE", 409, "BOOKING_NOT_CANCELLABLE", "這筆預約目前無法申請取消。"],
    ["CANCELLATION_NOT_PENDING", 409, "CANCELLATION_NOT_PENDING", "這筆預約目前沒有待確認的取消申請。"],
    ["BOOKING_COMPLETION_REQUIRES_SETTLEMENT", 409, "BOOKING_COMPLETION_CANONICAL_REQUIRED", "完成預約必須使用結算流程。"],
    ["INVALID_BOOKING_BENEFITS", 400, "INVALID_BOOKING_BENEFITS", "選用優惠資料格式不正確。"],
    ["EVENT_TICKET_ALREADY_REGISTERED", 409, "EVENT_TICKET_ALREADY_REGISTERED", "這張活動票券已在一般預約或快照模式登記，不能重複登記。"],
    ["BOOKING_BENEFIT_NOT_AVAILABLE", 409, "BOOKING_BENEFIT_NOT_AVAILABLE", "其中一項優惠目前已不可使用，請重新整理後再選擇。"],
    ["BOOKING_BENEFIT_LOCATION_REQUIRED", 409, "BOOKING_BENEFIT_LOCATION_REQUIRED", "其中一張票券需要定位核銷，無法綁定至預約自動核銷。"],
    ["BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED",409,"BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED","已核銷票券所需的服務項目不能移除。"],
    ["BOOKING_BENEFIT_SERVICE_REQUIRED", 409, "BOOKING_BENEFIT_SERVICE_REQUIRED", "所選票券需要預約指定項目，請確認本次預約項目後再試。"],
    ["booking_benefit_selections_one_pending_ticket_idx", 409, "BOOKING_BENEFIT_ALREADY_RESERVED", "其中一張票券已被另一筆預約選用，請重新整理後再選擇。"],
    ["POINT_TICKET_INSUFFICIENT_POINTS", 409, "POINT_TICKET_INSUFFICIENT_POINTS", "集點卡點數不足，請取消部分票券後再預約。"],
    ["BOOKING_HOLIDAY", 409, "BOOKING_HOLIDAY", "這一天為休假日，請選擇其他日期。"],
    ["BOOKING_SLOT_TAKEN", 409, "BOOKING_SLOT_TAKEN", "這段時間剛剛已被其他會員預約，請選擇其他時間。"],
    ["BOOKING_TOO_EARLY", 409, "BOOKING_TOO_EARLY", "尚未符合提前預約天數，請選擇較晚的日期。"],
    ["BOOKING_TOO_FAR", 409, "BOOKING_TOO_FAR", "此日期超過可預約範圍，請選擇較近的日期。"],
    ["BOOKING_TIME_PASSED", 409, "BOOKING_TIME_PASSED", "這個預約時間已經過了，請重新選擇。"],
    ["BOOKING_SERVICE_DISABLED", 409, "BOOKING_SERVICE_DISABLED", "其中一個預約項目目前未開放。"],
    ["BOOKING_ADD_ON_REQUIRES_COMPANION", 400, "BOOKING_ADD_ON_REQUIRES_COMPANION", "加購項目不能單獨預約，請至少再選擇一個一般項目。"],
    ["BOOKING_SERVICE_NOT_FOUND", 404, "BOOKING_SERVICE_NOT_FOUND", "找不到其中一個預約項目。"],
    ["BOOKING_SETTINGS_MISSING", 503, "BOOKING_SETTINGS_MISSING", "預約共用設定尚未完成。"],
    ["BOOKING_SETTINGS_CONFLICT", 409, "CONFLICT", "預約共用設定已被其他操作更新，請重新整理後再試。"],
    ["BOOKING_SERVICE_TYPE_IN_USE", 409, "BOOKING_SERVICE_TYPE_IN_USE", "仍有預約項目使用這個項目類型，請先調整項目後再移除。"],
    ["BOOKING_SERVICE_TYPE_REQUIRED", 400, "BOOKING_SERVICE_TYPE_REQUIRED", "請先在預約共用設定建立並選擇項目類型。"],
    ["BOOKING_SERVICE_TYPE_INVALID", 400, "BOOKING_SERVICE_TYPE_INVALID", "所選項目類型不在預約共用設定中，請重新選擇。"],
    ["INVALID_SERVICE_TYPES", 400, "INVALID_SERVICE_TYPES", "項目類型設定格式不正確。"],
    ["DUPLICATE_SERVICE_TYPE", 400, "DUPLICATE_SERVICE_TYPE", "項目類型不可重複。"],
    ["INVALID_BOOKING_ITEMS", 400, "INVALID_BOOKING_ITEMS", "請至少選擇一個預約項目。"],
    ["INVALID_BOOKING_QUANTITY", 400, "INVALID_BOOKING_QUANTITY", "每個預約項目的數量只能選擇 1 或 2。"],
    ["DUPLICATE_BOOKING_SERVICE", 400, "DUPLICATE_BOOKING_SERVICE", "同一個預約項目只能選擇一次，請用數量調整。"],
    ["INVALID_BOOKING_DURATION", 400, "INVALID_BOOKING_DURATION", "預約服務總時間不正確。"],
    ["INVALID_BOOKING_SLOT", 400, "INVALID_BOOKING_SLOT", "這段預約時間超出管理員上班時間。"],
    ["REQUEST_ID_CONFLICT", 409, "REQUEST_ID_CONFLICT", "操作識別碼衝突，請重新操作。"],
    ["MEMBERSHIP_REQUIRED", 403, "MEMBERSHIP_REQUIRED", "請先加入會員並完成會員資料後再使用預約功能。"],
    ["MEMBER_DISABLED", 403, "MEMBER_DISABLED", "此會員目前已停用，無法預約。"],
    ["MEMBER_NOT_FOUND", 403, "MEMBERSHIP_REQUIRED", "請先加入會員並完成會員資料後再使用預約功能。"],
  ];
  for (const [needle, status, code, userMessage] of rules) {
    if (message.includes(needle)) return new ApiError(status, code, userMessage);
  }
  if (raw?.code === "23P01" || raw?.code === "23505") {
    return new ApiError(409, "BOOKING_SLOT_TAKEN", "這段時間已被預約，請選擇其他時間。");
  }
  return new ApiError(500, "DATABASE_ERROR", "資料庫暫時無法完成預約操作。");
}

function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function channelIdFor(clientType: ClientType): string {
  const envName = clientType === "admin" ? "LINE_ADMIN_CHANNEL_ID" : "LINE_MEMBER_CHANNEL_ID";
  const fallback = clientType === "admin" ? "2010791619" : "2010787602";
  const value = env(envName) || fallback;
  if (!/^\d{5,30}$/.test(value)) throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 驗證設定尚未完成。");
  return value;
}

async function verifyLineIdToken(idToken: string, clientType: ClientType): Promise<Identity> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: channelIdFor(clientType),
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  }) as Identity;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeRateLimit(supabase: SupabaseClient, identity: Identity, action: string): Promise<void> {
  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_principal_hash: await sha256(identity.lineUserId),
    p_is_write: WRITE_ACTIONS.has(action),
    p_cost: 1,
    p_read_limit: READ_LIMIT,
    p_write_limit: WRITE_LIMIT,
  });
  if (error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。");
  if (!data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。");
}

async function requireJoinedMember(supabase: SupabaseClient, identity: Identity): Promise<any> {
  const result = await supabase.from("members").select("*").eq("line_user_id", identity.lineUserId).maybeSingle();
  if (result.error) throw mapDatabaseError(result.error);
  const member = result.data;
  if (!member || member.membership_status !== "active") {
    throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先加入會員並完成會員資料後再使用預約功能。");
  }
  if (member.status !== "active") throw new ApiError(403, "MEMBER_DISABLED", "此會員目前已停用，無法預約。");
  if (!(await hasCurrentTermsConsent(supabase, member.id))) throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先至會員卡同意新版條款。");
  return member;
}

async function authorizeAdmin(supabase: SupabaseClient, identity: Identity): Promise<any> {
  return await requireActiveAdminContract({
    supabase,
    identity,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function requireUuid(value: unknown, label: string): string {
  const text = asText(value, 60);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new ApiError(400, "INVALID_INPUT", `${label}格式不正確。`);
  }
  return text;
}

function requireDate(value: unknown): string {
  const text = asText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ApiError(400, "INVALID_DATE", "請選擇正確的預約日期。");
  }
  return text;
}

function normalizeTime(value: unknown): string {
  const text = asText(value, 8);
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match) throw new ApiError(400, "INVALID_TIME", "時間格式不正確。");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute > 59 || minute % 5 !== 0 || (text.length === 8 && !text.endsWith(":00"))) throw new ApiError(400, "INVALID_TIME", "時間必須以 5 分鐘為起始邊界。");
  return `${match[1]}:${match[2]}`;
}

function timeToMinutes(value: string): number {
  const [hour, minute] = String(value || "").slice(0, 5).split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function taipeiDate(): string {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).forEach((part) => { if (part.type !== "literal") parts[part.type] = part.value; });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function taipeiMinutes(): number {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).forEach((part) => { if (part.type !== "literal") parts[part.type] = part.value; });
  return Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function normalizeServiceTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ApiError(400, "INVALID_SERVICE_TYPES", "項目類型必須是最多 50 筆的清單。");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const name = String(raw ?? "").trim();
    if (!name || name.length > 80) {
      throw new ApiError(400, "INVALID_SERVICE_TYPES", "每個項目類型必須是 1–80 字。");
    }
    const key = name.toLocaleLowerCase("zh-Hant-TW");
    if (seen.has(key)) throw new ApiError(400, "DUPLICATE_SERVICE_TYPE", `項目類型「${name}」重複。`);
    seen.add(key);
    result.push(name);
  }
  return result;
}

function legacyServiceType(description: unknown): string {
  const text = String(description ?? "").trim();
  return text.startsWith(TYPE_PREFIX) ? text.slice(TYPE_PREFIX.length).trim() : "";
}

function settingsClient(row: any): Json {
  return {
    workStartTime: String(row?.work_start_time || "09:00:00").slice(0, 5),
    workEndTime: String(row?.work_end_time || "17:00:00").slice(0, 5),
    slotIntervalMinutes: Number(row?.slot_interval_minutes || 30),
    minAdvanceDays: Number(row?.min_advance_days || 0),
    maxAdvanceDays: Number(row?.max_advance_days || 0),
    updatedAt: row?.updated_at || null,
  };
}

function serviceClient(row: any): Json {
  return {
    serviceId: row.id,
    title: row.title,
    description: row.description || "",
    serviceType: row.service_type || "",
    durationMinutes: Number(row.duration_minutes || 30),
    priceAmount: Number(row.price_amount || 0),
    requiresCompanionService: Boolean(row.requires_companion_service),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemClient(row: any): Json {
  const quantity = Number(row.quantity || 1);
  const unitPriceAmount = Number(row.unit_price_amount || 0);
  return {
    serviceId: row.service_id,
    serviceTitle: row.service_title || "預約項目",
    unitDurationMinutes: Number(row.unit_duration_minutes || 0),
    unitPriceAmount,
    quantity,
    subtotalMinutes: Number(row.unit_duration_minutes || 0) * quantity,
    subtotalAmount: unitPriceAmount * quantity,
  };
}

function benefitClient(row: any): Json {
  return {
    kind: row.benefit_kind,
    id: row.benefit_ref,
    title: row.title_snapshot || "可用權益",
    status: row.status || "pending", cancellationReason: row.result?.cancellationReason || "",
    redeemedAt: row.redeemed_at || null,
  };
}

function normalizeBookingBenefits(value: unknown): Json[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, "INVALID_BOOKING_BENEFITS", "選用優惠資料格式不正確。");
  const seen = new Set<string>();
  return value.map((raw) => {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const kind = asText(item.kind, 20).toLowerCase();
    const id = asText(item.id, 160);
    const key = `${kind}:${id}`;
    if (!["points","event"].includes(kind) || !id || seen.has(key)) {
      throw new ApiError(400, "INVALID_BOOKING_BENEFITS", "選用優惠資料格式不正確。");
    }
    seen.add(key);
    return { kind, id };
  });
}

async function validateBookingBenefitSelectionLimit(supabase: SupabaseClient, value: unknown): Promise<Json[]> {
  const benefits = normalizeBookingBenefits(value);
  const eventCount = benefits.filter((item) => item.kind === "event").length;
  const pointCount = benefits.filter((item) => item.kind === "points").length;
  if (!eventCount && !pointCount) return benefits;

  const [eventSetting, pointSetting] = await Promise.all([
    eventCount
      ? supabase.from("event_ticket_settings")
          .select("max_tickets_per_day")
          .eq("id", 1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    pointCount
      ? supabase.from("point_card_settings")
          .select("max_tickets_per_redemption")
          .eq("id", 1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (eventSetting.error) throw mapDatabaseError(eventSetting.error);
  if (pointSetting.error) throw mapDatabaseError(pointSetting.error);

  const rawEventLimit = Number(eventSetting.data?.max_tickets_per_day ?? 1);
  const maxTicketsPerDay = Number.isInteger(rawEventLimit) && rawEventLimit >= 0 && rawEventLimit <= 50 ? rawEventLimit : 1;
  const rawPointLimit = Number(pointSetting.data?.max_tickets_per_redemption ?? 1);
  const maxPointTicketsPerRedemption = Number.isInteger(rawPointLimit) && rawPointLimit >= 0 && rawPointLimit <= 50 ? rawPointLimit : 1;

  if (maxTicketsPerDay > 0 && eventCount > maxTicketsPerDay) {
    throw new ApiError(409, "EVENT_TICKET_SELECTION_LIMIT_EXCEEDED", `活動票券每筆預約最多可選 ${maxTicketsPerDay} 張。`);
  }
  if (maxPointTicketsPerRedemption > 0 && pointCount > maxPointTicketsPerRedemption) {
    throw new ApiError(409, "POINT_TICKET_SELECTION_LIMIT_EXCEEDED", `集點卡票券每筆預約最多可選 ${maxPointTicketsPerRedemption} 張。`);
  }
  return benefits;
}

function bookingClient(row: any, items: any[] = [], benefits: any[] = []): Json {
  const member = row.members || row.member || null;
  const mappedItems = items.map(itemClient);
  return {
    bookingId: row.id,
    requestId: row.request_id,
    serviceId: row.service_id,
    serviceTitle: mappedItems.length ? mappedItems.map((item: any) => item.serviceTitle).join(" + ") : "預約項目",
    items: mappedItems,
    benefits: benefits.map(benefitClient),
    totalDurationMinutes: Number(row.total_duration_minutes || 30),
    totalAmount: mappedItems.reduce((sum, item: any) => sum + Number(item.subtotalAmount || 0), 0),
    memberId: row.member_id,
    bookingSource: !row.member_id && String(row.request_id || "").startsWith("PHONE-") ? "phone" : "member",
    memberDisplayName: member?.display_name || "",
    memberCode: member?.member_code || "",
    bookingDate: row.booking_date,
    startTime: String(row.start_time || "").slice(0, 5),
    endTime: String(row.end_time || "").slice(0, 5),
    startAt: localTimestamp(row.start_at),
    endAt: localTimestamp(row.end_at),
    status: row.status,
    memberNote: row.member_note || "",
    adminNote: row.admin_note || "",
    completedAt: row.completed_at || null,
    receiptSubmissionId:row.receipt_submission_id || null,
    noShowAt:row.no_show_at || null,
    confirmedAt: row.confirmed_at,
    rejectedAt: row.rejected_at,
    cancelledAt: row.cancelled_at,
    cancellationRequestedAt: row.cancellation_requested_at || null,
    cancellationReviewedAt: row.cancellation_reviewed_at || null,
    cancellationDecision: row.cancellation_decision || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function hydrateBookings(supabase: SupabaseClient, rows: any[]): Promise<Json[]> {
  if (!rows.length) return [];
  const bookingIds = rows.map((row) => row.id);
  const [itemResult, benefitResult] = await Promise.all([
    supabase.from("booking_items")
      .select("booking_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity")
      .in("booking_id", bookingIds)
      .order("created_at", { ascending: true }),
    supabase.from("booking_benefit_selections")
      .select("booking_id,benefit_kind,benefit_ref,title_snapshot,status,redeemed_at,selected_at,result")
      .in("booking_id", bookingIds)
      .order("selected_at", { ascending: true }),
  ]);
  if (itemResult.error) throw mapDatabaseError(itemResult.error);
  if (benefitResult.error) throw mapDatabaseError(benefitResult.error);
  const grouped = new Map<string, any[]>();
  const benefitGrouped = new Map<string, any[]>();
  for (const item of itemResult.data || []) {
    const values = grouped.get(item.booking_id) || [];
    values.push(item);
    grouped.set(item.booking_id, values);
  }
  for (const benefit of benefitResult.data || []) {
    if (!["points","event"].includes(String(benefit.benefit_kind || ""))) continue;
    const values = benefitGrouped.get(benefit.booking_id) || [];
    values.push(benefit);
    benefitGrouped.set(benefit.booking_id, values);
  }
  return rows.map((row) => bookingClient(row, grouped.get(row.id) || [], benefitGrouped.get(row.id) || []));
}

async function bookingSettings(supabase: SupabaseClient): Promise<any> {
  const result = await supabase.from("booking_settings").select("*").eq("id", 1).maybeSingle();
  if (result.error) throw mapDatabaseError(result.error);
  if (!result.data) throw new ApiError(503, "BOOKING_SETTINGS_MISSING", "預約共用設定尚未完成。");
  return result.data;
}

function assertBookingDateWindow(date: string, settings: any): void {
  const today = currentBusinessDate(taipeiDate(), taipeiMinutes(), settings.work_start_time, settings.work_end_time);
  const earliestBookingDate = addDays(today, Number(settings?.min_advance_days || 0));
  const maxAdvanceDays = Number(settings?.max_advance_days || 0);
  const latestBookingDate = maxAdvanceDays > 0 ? addDays(today, maxAdvanceDays) : "";
  if (date < earliestBookingDate) throw new ApiError(409, "BOOKING_TOO_EARLY", "尚未符合提前預約天數，請選擇較晚的日期。");
  if (latestBookingDate && date > latestBookingDate) throw new ApiError(409, "BOOKING_TOO_FAR", "此日期超過可預約範圍，請選擇較近的日期。");
}

async function bookingServiceTypes(supabase: SupabaseClient): Promise<string[]> {
  const result = await supabase.from("booking_service_types")
    .select("name")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (result.error) throw mapDatabaseError(result.error);
  return (result.data || []).map((row: any) => String(row.name || "").trim()).filter(Boolean);
}

async function activeServices(supabase: SupabaseClient): Promise<any[]> {
  const result = await supabase.from("booking_services").select("*").eq("is_active", true).order("created_at", { ascending: true });
  if (result.error) throw mapDatabaseError(result.error);
  return result.data || [];
}

async function isActiveBookingHoliday(supabase: SupabaseClient, date: string): Promise<boolean> {
  const result = await supabase.from("calendar_items")
    .select("id,starts_on,ends_on")
    .eq("item_type", "holiday")
    .eq("status", "active")
    .lte("starts_on", date);
  if (result.error) throw mapDatabaseError(result.error);
  return (result.data || []).some((row: any) =>
    String(row.starts_on || "") <= date
    && String(row.ends_on || row.starts_on || "") >= date
  );
}

async function bookingServiceTypeRewards(supabase: SupabaseClient): Promise<Json[]> {
  const [rewardResult, typeResult, cardResult] = await Promise.all([
    supabase.from("booking_service_type_rewards").select("service_type_id,point_card_id,minutes_per_point"),
    supabase.from("booking_service_types").select("id,name"),
    supabase.from("point_cards").select("id,title"),
  ]);
  if (rewardResult.error) throw mapDatabaseError(rewardResult.error);
  if (typeResult.error) throw mapDatabaseError(typeResult.error);
  if (cardResult.error) throw mapDatabaseError(cardResult.error);

  const typeNames = new Map((typeResult.data || []).map((row: any) => [String(row.id), String(row.name || "").trim()]));
  const cardTitles = new Map((cardResult.data || []).map((row: any) => [String(row.id), String(row.title || "").trim()]));
  return (rewardResult.data || []).map((row: any) => ({
    serviceType: typeNames.get(String(row.service_type_id)) || "",
    pointCardId: String(row.point_card_id || ""),
    pointCardTitle: cardTitles.get(String(row.point_card_id)) || "",
    minutesPerPoint: Number(row.minutes_per_point || 0),
  })).filter((row: any) => row.serviceType && row.pointCardId && row.pointCardTitle && Number.isInteger(row.minutesPerPoint) && row.minutesPerPoint > 0);
}

async function normalizeRequestedItems(supabase: SupabaseClient, body: Json): Promise<RequestedItem[]> {
  const rawItems = Array.isArray(body.items) && body.items.length
    ? body.items
    : body.serviceId ? [{ serviceId: body.serviceId, quantity: 1 }] : [];
  if (!rawItems.length || rawItems.length > 20) throw new ApiError(400, "INVALID_BOOKING_ITEMS", "請至少選擇一個預約項目。");

  const seen = new Set<string>();
  const requested: Array<{ serviceId: string; quantity: number }> = [];
  for (const raw of rawItems) {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const serviceId = requireUuid(item.serviceId, "預約項目");
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2) {
      throw new ApiError(400, "INVALID_BOOKING_QUANTITY", "每個預約項目的數量只能選擇 1 或 2。");
    }
    if (seen.has(serviceId)) throw new ApiError(400, "DUPLICATE_BOOKING_SERVICE", "同一個預約項目只能選擇一次，請用數量調整。");
    seen.add(serviceId);
    requested.push({ serviceId, quantity });
  }

  const serviceResult = await supabase.from("booking_services").select("*").in("id", requested.map((item) => item.serviceId));
  if (serviceResult.error) throw mapDatabaseError(serviceResult.error);
  const serviceById = new Map((serviceResult.data || []).map((service: any) => [String(service.id), service]));
  const normalized: RequestedItem[] = requested.map(({ serviceId, quantity }) => {
    const service = serviceById.get(serviceId);
    if (!service) throw new ApiError(404, "BOOKING_SERVICE_NOT_FOUND", "找不到其中一個預約項目。");
    if (!service.is_active) throw new ApiError(409, "BOOKING_SERVICE_DISABLED", "其中一個預約項目目前未開放。");
    return { serviceId, quantity, service };
  });
  const visibleItems = normalized.filter((item) => item.serviceId !== STORE_SERVICE_ID);
  if (visibleItems.some((item) => Boolean(item.service.requires_companion_service))
      && !visibleItems.some((item) => !Boolean(item.service.requires_companion_service))) {
    throw new ApiError(400, "BOOKING_ADD_ON_REQUIRES_COMPANION", "加購項目不能單獨預約，請至少再選擇一個一般項目。");
  }
  return normalized;
}

function totalDuration(items: RequestedItem[]): number {
  return items.reduce((sum, item) => sum + Number(item.service.duration_minutes || 0) * item.quantity, 0);
}

function totalAmount(items: RequestedItem[]): number {
  return items.reduce((sum, item) => sum + Number(item.service.price_amount || 0) * item.quantity, 0);
}

async function generateSlots(supabase: SupabaseClient, body: Json, member: any): Promise<Json> {
  const date = requireDate(body.bookingDate);
  const items = await normalizeRequestedItems(supabase, body);
  const settings = await bookingSettings(supabase);
  const duration = totalDuration(items);
  if (duration < 1 || duration > 1440) throw new ApiError(400, "INVALID_BOOKING_DURATION", "預約服務總時間不正確。");

  const today = currentBusinessDate(taipeiDate(), taipeiMinutes(), settings.work_start_time, settings.work_end_time);
  const earliestBookingDate = addDays(today, Number(settings.min_advance_days || 0));
  const maxAdvanceDays = Number(settings.max_advance_days || 0);
  const latestBookingDate = maxAdvanceDays > 0 ? addDays(today, maxAdvanceDays) : "";
  if (date < earliestBookingDate || (latestBookingDate && date > latestBookingDate)) {
    return {
      serverNow: new Date().toISOString(),
      settings: settingsClient(settings),
      totalDurationMinutes: duration,
      totalAmount: totalAmount(items),
      earliestBookingDate,
      latestBookingDate: latestBookingDate || null,
      slots: [],
    };
  }
  if (await isActiveBookingHoliday(supabase, date)) {
    return {
      serverNow: new Date().toISOString(),
      settings: settingsClient(settings),
      totalDurationMinutes: duration,
      totalAmount: totalAmount(items),
      earliestBookingDate,
      latestBookingDate: latestBookingDate || null,
      holidayBlocked: true,
      slots: [],
    };
  }

  let excludedId = "";
  if (body.bookingId) {
    excludedId = requireUuid(body.bookingId, "預約");
    const owned = await supabase.from("bookings").select("id,status").eq("id", excludedId).eq("member_id", member.id).maybeSingle();
    if (owned.error) throw mapDatabaseError(owned.error);
    if (!owned.data || !["pending", "confirmed"].includes(owned.data.status)) throw new ApiError(409, "BOOKING_NOT_EDITABLE", "找不到可修改的預約。");
  }
  const bookings = await supabase.from("bookings")
    .select("id,start_at,end_at")
    .gte("booking_date", addDays(date, -1)).lte("booking_date", addDays(date, 1))
    .in("status", ["pending", "confirmed"]);
  if (bookings.error) throw mapDatabaseError(bookings.error);
  const occupied = (bookings.data || []).filter((row: any) => row.id !== excludedId).map(occupiedRange);

  const workStart = timeToMinutes(settings.work_start_time);
  const workEnd = workWindow(settings.work_start_time, settings.work_end_time).end;
  const interval = Number(settings.slot_interval_minutes || SLOT_START_INTERVAL_MINUTES);
  const slots: Json[] = [];
  for (let cursor = workStart; cursor + duration <= workEnd; cursor += interval) {
    const candidateEnd = cursor + duration;
    const candidate = localRange(date, cursor, duration);
    const overlap = occupied.some((range: any) => candidate.start < range.end && candidate.end > range.start);
    const passed = slotHasPassed(date, cursor);
    slots.push({
      startTime: clockTime(cursor),
      endTime: clockTime(candidateEnd),
      startAt: timeOnBusinessDate(date, cursor),
      endAt: timeOnBusinessDate(date, candidateEnd),
      available: !overlap && !passed,
    });
  }

  return {
    serverNow: new Date().toISOString(),
    settings: settingsClient(settings),
    totalDurationMinutes: duration,
    totalAmount: totalAmount(items),
    earliestBookingDate,
    latestBookingDate: latestBookingDate || null,
    slots,
  };
}

async function audit(supabase: SupabaseClient, identity: Identity, role: "member" | "admin", action: string, targetType: string, targetId: string, metadata: Json = {}): Promise<void> {
  const result = await supabase.from("booking_audit_events").insert({
    actor_line_user_id: identity.lineUserId,
    actor_role: role,
    action,
    target_type: targetType,
    target_id: targetId,
    result: "success",
    metadata,
  });
  if (result.error) console.error("booking audit insert failed", result.error.message);
}

async function userBootstrap(supabase: SupabaseClient, member: any, body:Json={}): Promise<Json> {
  const [settings, services, serviceTypeRewards, bookingResult, noShowResult] = await Promise.all([
    bookingSettings(supabase),
    activeServices(supabase),
    bookingServiceTypeRewards(supabase),
    supabase.from("bookings")
      .select("*")
      .eq("member_id", member.id)
      .order("booking_date", { ascending: false })
      .order("start_time", { ascending: false })
      .limit(50),
    // Keep no-show history visible after newer reservations fill the usual window.
    supabase.from("bookings")
      .select("*")
      .eq("member_id", member.id)
      .eq("status", "no_show")
      .order("booking_date", { ascending: false })
      .order("start_time", { ascending: false })
      .limit(50),
  ]);
  if ((bookingResult as any).error) throw mapDatabaseError((bookingResult as any).error);
  if ((noShowResult as any).error) throw mapDatabaseError((noShowResult as any).error);
  const bookingRows = new Map<string, any>();
  for (const row of [...(bookingResult.data || []), ...(noShowResult.data || [])]) bookingRows.set(row.id, row);
  const target=await linkedBooking(supabase,asText(body.bookingId,60),String(member.id));
  if(target) bookingRows.set(target.id, target);
  return {
    serverNow: new Date().toISOString(),
    today: currentBusinessDate(taipeiDate(), taipeiMinutes(), settings.work_start_time, settings.work_end_time),
    settings: { ...settingsClient(settings), serviceTypeRewards },
    services: services.map(serviceClient),
    bookings: await hydrateBookings(supabase, [...bookingRows.values()].sort((a, b) => `${b.booking_date} ${b.start_time}`.localeCompare(`${a.booking_date} ${a.start_time}`))),
  };
}

async function userCreate(supabase: SupabaseClient, identity: Identity, member: any, body: Json): Promise<Json> {
  const bookingDate = requireDate(body.bookingDate);
  const settings = await bookingSettings(supabase);
  assertBookingDateWindow(bookingDate, settings);
  const startTime = normalizeTime(body.startTime);
  const requestId = asText(body.requestId, 100);
  if (!/^BOOK-[A-Za-z0-9-]{8,95}$/.test(requestId)) throw new ApiError(400, "INVALID_REQUEST_ID", "操作識別碼格式不正確。");
  const memberNote = asText(body.memberNote, 500);
  const items = await normalizeRequestedItems(supabase, body);
  const rpcItems = items.map((item) => ({ serviceId: item.serviceId, quantity: item.quantity }));
  const benefits = await validateBookingBenefitSelectionLimit(supabase, body.benefits);

  const created = await supabase.rpc("create_booking_bundle_with_benefits_request", {
    p_request_id: requestId,
    p_member_id: member.id,
    p_booking_date: bookingDate,
    p_start_time: `${startTime}:00`,
    p_items: rpcItems,
    p_member_note: memberNote,
    p_benefits: benefits,
  });
  if (created.error) throw mapDatabaseError(created.error);
  const row = Array.isArray(created.data) ? created.data[0] : created.data;
  if (!row) throw new ApiError(500, "BOOKING_CREATE_FAILED", "預約未完成，請稍後再試。");
  const hydrated = await hydrateBookings(supabase, [row]);
  await audit(supabase, identity, "member", "BOOKING_REQUESTED", "booking", String(row.id), {
    bookingDate,
    startTime,
    totalDurationMinutes: totalDuration(items),
    totalAmount: totalAmount(items),
    items: rpcItems,
  });
  return { booking: hydrated[0] };
}

async function userUpdate(supabase: SupabaseClient, identity: Identity, member: any, body: Json): Promise<Json> {
  const bookingId = requireUuid(body.bookingId, "預約");
  const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) throw new ApiError(400, "INVALID_INPUT", "缺少預約版本，請重新整理。");
  const requestId = asText(body.requestId, 100);
  if (!/^BOOK-[A-Za-z0-9-]{8,95}$/.test(requestId)) throw new ApiError(400, "INVALID_REQUEST_ID", "操作識別碼格式不正確。");
  const bookingDate = requireDate(body.bookingDate);
  const settings = await bookingSettings(supabase);
  assertBookingDateWindow(bookingDate, settings);
  const items = await normalizeRequestedItems(supabase, body);
  const benefits = await validateBookingBenefitSelectionLimit(supabase, body.benefits);
  const result = await supabase.rpc("update_booking_bundle_with_benefits_request", {
    p_booking_id: bookingId, p_member_id: member.id,
    p_expected_updated_at: expectedUpdatedAt, p_request_id: requestId,
    p_booking_date: bookingDate, p_start_time: `${normalizeTime(body.startTime)}:00`,
    p_items: items.map((item) => ({ serviceId: item.serviceId, quantity: item.quantity })),
    p_member_note: asText(body.memberNote, 500), p_actor: identity.lineUserId,
    p_benefits: benefits,
  });
  if (result.error) throw mapDatabaseError(result.error);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row) throw new ApiError(500, "BOOKING_UPDATE_FAILED", "無法確認修改結果，請更新預約紀錄。");
  return { booking: (await hydrateBookings(supabase, [row]))[0] };
}

async function userCancel(supabase: SupabaseClient, identity: Identity, member: any, body: Json): Promise<Json> {
  const bookingId = requireUuid(body.bookingId, "預約");
  const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
  const result = await supabase.rpc("request_booking_cancellation", {
    p_booking_id: bookingId,
    p_member_id: member.id,
    p_actor: identity.lineUserId,
    p_expected_updated_at: expectedUpdatedAt || null,
  });
  if (result.error) throw mapDatabaseError(result.error);

  const current = await supabase.from("bookings").select("*").eq("id", bookingId).eq("member_id", member.id).maybeSingle();
  if (current.error) throw mapDatabaseError(current.error);
  if (!current.data) throw new ApiError(404, "BOOKING_NOT_FOUND", "找不到這筆預約。");

  const rpcResult = result.data && typeof result.data === "object" ? result.data as Json : {};
  const alreadyRequested = rpcResult.alreadyRequested === true;
  const hydrated = (await hydrateBookings(supabase, [current.data]))[0];
  if (!alreadyRequested) {
    await audit(supabase, identity, "member", "BOOKING_CANCELLATION_REQUESTED", "booking", bookingId, {
      sourceStatus: current.data.status,
      canonicalCommand: "request_booking_cancellation",
    });
  }
  return {
    booking: { ...hydrated, baseStatus: current.data.status, status: "cancel_requested" },
    alreadyRequested,
  };
}

async function adminSettingsSave(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const workStartTime = normalizeTime(body.workStartTime);
  const workEndTime = normalizeTime(body.workEndTime);
  const minAdvanceDays = Number(body.minAdvanceDays);
  const maxAdvanceDays = Number(body.maxAdvanceDays);
  if (timeToMinutes(workEndTime) - timeToMinutes(workStartTime) < SLOT_START_INTERVAL_MINUTES) {
    throw new ApiError(400, "INVALID_WORK_HOURS", "結束工作時間必須晚於開始工作時間至少 30 分鐘。");
  }
  if (!Number.isInteger(minAdvanceDays) || minAdvanceDays < 0 || minAdvanceDays > 365) {
    throw new ApiError(400, "INVALID_ADVANCE_DAYS", "提前預約天數必須介於 0–365 天。");
  }
  if (!Number.isInteger(maxAdvanceDays) || maxAdvanceDays < 0 || maxAdvanceDays > 365) {
    throw new ApiError(400, "INVALID_MAX_ADVANCE_DAYS", "最遠可預約天數必須介於 0–365 天；0 代表不限制。");
  }
  if (maxAdvanceDays > 0 && maxAdvanceDays < minAdvanceDays) {
    throw new ApiError(400, "INVALID_ADVANCE_WINDOW", "最遠可預約天數不可小於需要提前的天數。");
  }

  const current = await bookingSettings(supabase);
  const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
  if (expectedUpdatedAt && current.updated_at !== expectedUpdatedAt) {
    throw new ApiError(409, "CONFLICT", "預約共用設定已被其他操作更新，請重新整理後再試。");
  }

  const hasServiceTypes = Object.prototype.hasOwnProperty.call(body, "serviceTypes");
  const serviceTypes = hasServiceTypes ? normalizeServiceTypes(body.serviceTypes) : await bookingServiceTypes(supabase);
  const saved = await supabase.rpc("save_booking_settings_with_service_types", {
    p_work_start_time: `${workStartTime}:00`,
    p_work_end_time: `${workEndTime}:00`,
    p_min_advance_days: minAdvanceDays,
    p_max_advance_days: maxAdvanceDays,
    p_service_types: serviceTypes,
    p_expected_updated_at: expectedUpdatedAt || null,
    p_actor: identity.lineUserId,
  });
  if (saved.error) throw mapDatabaseError(saved.error);

  const [updated, persistedServiceTypes] = await Promise.all([
    bookingSettings(supabase),
    bookingServiceTypes(supabase),
  ]);
  await audit(supabase, identity, "admin", "BOOKING_SETTINGS_UPDATED", "booking_settings", "1", {
    workStartTime,
    workEndTime,
    minAdvanceDays,
    maxAdvanceDays,
    serviceTypes: persistedServiceTypes,
  });
  return { settings: { ...settingsClient(updated), serviceTypes: persistedServiceTypes } };
}

async function adminServiceSave(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const serviceId = asText(body.serviceId, 60);
  if (serviceId) requireUuid(serviceId, "預約項目");
  if (serviceId === STORE_SERVICE_ID) {
    throw new ApiError(409, "BOOKING_SYSTEM_SERVICE_IMMUTABLE", "店內固定服務不可從一般預約項目編輯。" );
  }

  const title = asText(body.title, 100);
  if (!title) throw new ApiError(400, "INVALID_INPUT", "預約項目名稱不可空白。");
  const requestedServiceType = asText(body.serviceType, 80) || legacyServiceType(body.description);
  if (!requestedServiceType) {
    throw new ApiError(400, "BOOKING_SERVICE_TYPE_REQUIRED", "請從預約共用設定選擇項目類型。" );
  }
  const allowedServiceTypes = await bookingServiceTypes(supabase);
  const serviceType = allowedServiceTypes.find((name) => name.toLocaleLowerCase("zh-Hant-TW") === requestedServiceType.toLocaleLowerCase("zh-Hant-TW"));
  if (!serviceType) {
    throw new ApiError(400, "BOOKING_SERVICE_TYPE_INVALID", "所選項目類型不在預約共用設定中，請重新選擇。" );
  }
  const description = `${TYPE_PREFIX}${serviceType}`;
  const isActive = body.isActive !== false;

  let current: any = null;
  if (serviceId) {
    const currentResult = await supabase.from("booking_services").select("*").eq("id", serviceId).maybeSingle();
    if (currentResult.error) throw mapDatabaseError(currentResult.error);
    current = currentResult.data;
    if (!current) throw new ApiError(404, "BOOKING_SERVICE_NOT_FOUND", "找不到這個預約項目。");
    const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
    if (expectedUpdatedAt && current.updated_at !== expectedUpdatedAt) {
      throw new ApiError(409, "CONFLICT", "此預約項目已被其他操作更新，請重新整理後再試。");
    }
  }

  const durationMinutes = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === ""
    ? Number(current?.duration_minutes || 30)
    : Number(body.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
    throw new ApiError(400, "INVALID_SERVICE_DURATION", "項目服務時間必須介於 1–720 分鐘。");
  }

  const priceAmount = body.priceAmount === undefined || body.priceAmount === null || body.priceAmount === ""
    ? Number(current?.price_amount || 0)
    : Number(body.priceAmount);
  if (!Number.isSafeInteger(priceAmount) || priceAmount < 0 || priceAmount > 10_000_000) {
    throw new ApiError(400, "INVALID_SERVICE_PRICE", "項目價格必須是 0–10,000,000 元的整數。");
  }

  const patch = {
    title,
    description,
    service_type: serviceType,
    duration_minutes: durationMinutes,
    price_amount: priceAmount,
    is_active: isActive,
  };

  let savedService: any;
  if (serviceId) {
    const updated = await supabase.from("booking_services").update(patch).eq("id", serviceId).select("*").single();
    if (updated.error) throw mapDatabaseError(updated.error);
    savedService = updated.data;
    await audit(supabase, identity, "admin", "BOOKING_SERVICE_UPDATED", "booking_service", serviceId, { durationMinutes, priceAmount, serviceType });
  } else {
    const inserted = await supabase.from("booking_services").insert({ ...patch, created_by: identity.lineUserId }).select("*").single();
    if (inserted.error) throw mapDatabaseError(inserted.error);
    savedService = inserted.data;
    await audit(supabase, identity, "admin", "BOOKING_SERVICE_CREATED", "booking_service", String(savedService.id), { durationMinutes, priceAmount, serviceType });
  }
  return { service: serviceClient(savedService) };
}


async function adminCreatePhoneBooking(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  // Authorization occurs in route() before any admin operation. The SQL RPC
  // independently rechecks active administrator status within the tenant.
  const requestId = asText(body.requestId, 100);
  if (!/^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new ApiError(400, "INVALID_REQUEST_ID", "操作識別碼不正確，請重新開啟電話預約表單。");
  }
  if (body.allowOverlap !== true) {
    throw new ApiError(400, "BOOKING_OVERLAP_ACK_REQUIRED", "請先確認電話預約可能與現有預約重疊。");
  }
  const surname = asText(body.contactSurname, 41);
  const salutation = asText(body.contactSalutation, 10);
  const phone = asText(body.contactPhone, 35);
  if (!surname || surname.length > 40 || !["mr", "ms"].includes(salutation) ||
      !/^\\+?[0-9() -]{8,25}$/.test(phone)) {
    throw new ApiError(400, "INVALID_BOOKING_CONTACT", "請填寫客人姓氏、稱謂與有效的聯絡電話。");
  }
  const adminNote = asText(body.adminNote, 501);
  if (adminNote.length > 500) throw new ApiError(400, "INVALID_BOOKING_NOTE", "預約說明不得超過 500 字。");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
    throw new ApiError(400, "INVALID_BOOKING_ITEMS", "請至少選擇一個預約項目。");
  }
  const items = body.items.map((raw: any) => ({
    serviceId: requireUuid(raw?.serviceId, "服務項目"),
    quantity: Number(raw?.quantity ?? 1),
  }));
  if (items.some((item) => item.serviceId === STORE_SERVICE_ID || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 2) ||
      new Set(items.map((item) => item.serviceId)).size !== items.length) {
    throw new ApiError(400, "INVALID_BOOKING_ITEMS", "服務項目不得重複，每項數量限 1 或 2。");
  }
  const bookingDate = requireDate(body.bookingDate);
  const startTime = normalizeTime(body.startTime);
  const result = await supabase.rpc("admin_create_phone_booking_request", {
    p_request_id: requestId,
    p_actor: identity.lineUserId,
    p_booking_date: bookingDate,
    p_start_time: `${startTime}:00`,
    p_contact_surname: surname,
    p_contact_salutation: salutation,
    p_contact_phone: phone,
    p_items: items,
    p_admin_note: adminNote,
    p_allow_overlap: true,
  });
  if (result.error) throw mapDatabaseError(result.error);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row?.id) throw new ApiError(500, "BOOKING_CREATE_FAILED", "電話預約尚未完成，請重新整理確認。");
  return { bookingId: row.id, bookingSource: "phone", status: row.status };
}

async function adminBookings(supabase: SupabaseClient): Promise<Json[]> {
  const today = taipeiDate();
  const pending = await supabase.from("bookings")
    .select("*, members!bookings_member_id_fkey(display_name, member_code)")
    .eq("status", "pending")
    .order("booking_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(250);
  if (pending.error) throw mapDatabaseError(pending.error);

  const recent = await supabase.from("bookings")
    .select("*, members!bookings_member_id_fkey(display_name, member_code)")
    .gte("booking_date", addDays(today, -7))
    .order("booking_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(400);
  if (recent.error) throw mapDatabaseError(recent.error);

  // Include historical no-shows beyond the rolling seven-day operations view.
  const noShows = await supabase.from("bookings")
    .select("*, members!bookings_member_id_fkey(display_name, member_code)")
    .eq("status", "no_show")
    .order("booking_date", { ascending: false })
    .order("start_time", { ascending: false })
    .limit(100);
  if (noShows.error) throw mapDatabaseError(noShows.error);

  const rows = new Map<string, any>();
  for (const row of [...(pending.data || []), ...(recent.data || []), ...(noShows.data || [])]) rows.set(row.id, row);
  const sorted = [...rows.values()].sort((a, b) => `${a.booking_date} ${a.start_time}`.localeCompare(`${b.booking_date} ${b.start_time}`));
  return await hydrateBookings(supabase, sorted);
}

async function adminBookingSummary(supabase: SupabaseClient, identity: Identity): Promise<Json> {
  const [pendingResult, cancellationResult, accessibleReceiptResult, notificationResult] = await Promise.all([
    supabase.from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase.from("bookings")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "confirmed"])
      .not("cancellation_requested_at", "is", null)
      .is("cancellation_reviewed_at", null),
    supabase.from("booking_receipts")
      .select("id", { count: "exact", head: true })
      .eq("submission_mode", "accessible")
      .eq("status", "awaiting_review")
      .is("booking_id", null),
    supabase.rpc("admin_booking_notification_summary", {
      p_admin_line_user_id: identity.lineUserId,
    }),
  ]);
  if (pendingResult.error) throw mapDatabaseError(pendingResult.error);
  if (cancellationResult.error) throw mapDatabaseError(cancellationResult.error);
  if (accessibleReceiptResult.error) throw mapDatabaseError(accessibleReceiptResult.error);
  if (notificationResult.error) throw mapDatabaseError(notificationResult.error);
  const notifications = notificationResult.data && typeof notificationResult.data === "object"
    ? notificationResult.data as Json
    : {};
  return {
    pendingCount: Math.max(0, Number(pendingResult.count || 0)),
    cancellationRequestCount: Math.max(0, Number(cancellationResult.count || 0)),
    accessibleReceiptPendingCount: Math.max(0, Number(accessibleReceiptResult.count || 0)),
    unreadCount: Math.max(0, Number(notifications.unreadCount || 0)),
    unreadBookingCount: Math.max(0, Number(notifications.unreadBookingCount || 0)),
    unreadCancellationCount: Math.max(0, Number(notifications.unreadCancellationCount || 0)),
    latestNotificationId: Math.max(0, Number(notifications.latestNotificationId || 0)),
    lastReadNotificationId: Math.max(0, Number(notifications.lastReadNotificationId || 0)),
    generatedAt: new Date().toISOString(),
  };
}

async function adminMarkBookingNotificationsRead(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const raw = body.throughNotificationId;
  const parsed = raw === undefined || raw === null || raw === "" ? null : Number(raw);
  if (parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 0)) {
    throw new ApiError(400, "INVALID_NOTIFICATION_CURSOR", "通知讀取位置不正確。");
  }
  const result = await supabase.rpc("mark_admin_booking_notifications_read", {
    p_admin_line_user_id: identity.lineUserId,
    p_through_notification_id: parsed,
  });
  if (result.error) throw mapDatabaseError(result.error);
  return result.data && typeof result.data === "object" ? result.data as Json : {};
}

async function adminBootstrap(supabase: SupabaseClient, body:Json={}): Promise<Json> {
  const [settings, servicesResult, bookings, serviceTypes] = await Promise.all([
    bookingSettings(supabase),
    supabase.from("booking_services").select("*").order("created_at", { ascending: true }),
    adminBookings(supabase),
    bookingServiceTypes(supabase),
  ]);
  if ((servicesResult as any).error) throw mapDatabaseError((servicesResult as any).error);
  const target=await linkedBooking(supabase,asText(body.bookingId,60),null);
  if(target && !bookings.some((b:any)=>b.bookingId===target.id)) bookings.unshift(...await hydrateBookings(supabase,[target]));
  return {
    today: taipeiDate(),
    settings: { ...settingsClient(settings), serviceTypes },
    services: ((servicesResult as any).data || []).map(serviceClient),
    bookings,
  };
}

async function adminStatusUpdate(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const bookingId = requireUuid(body.bookingId, "預約");
  const nextStatus = asText(body.status, 20);
  if (nextStatus === "completed") {
    throw new ApiError(409, "BOOKING_COMPLETION_CANONICAL_REQUIRED", "完成預約必須使用結算流程，請重新整理後再試。");
  }
  if (nextStatus === "no_show") {
    const result = await supabase.rpc("admin_mark_booking_no_show", {
      p_actor:identity.lineUserId,p_booking_id:bookingId,
      p_expected_updated_at:asText(body.expectedUpdatedAt,80) || null,p_note:asText(body.adminNote,500),
    });
    if (result.error) throw mapDatabaseError(result.error);
    const row = await supabase.from("bookings").select("*, members!bookings_member_id_fkey(display_name, member_code)").eq("id",bookingId).single();
    if (row.error) throw mapDatabaseError(row.error);
    return { booking:(await hydrateBookings(supabase,[row.data]))[0],alreadyApplied:result.data?.alreadyApplied === true };
  }
  if (!["confirmed", "rejected", "cancelled"].includes(nextStatus)) {
    throw new ApiError(400, "INVALID_BOOKING_STATUS", "不支援的預約狀態。");
  }
  const adminNote = asText(body.adminNote, 500);
  const existing = await supabase.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (existing.error) throw mapDatabaseError(existing.error);
  const booking = existing.data;
  if (!booking) throw new ApiError(404, "BOOKING_NOT_FOUND", "找不到這筆預約。");

  const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
  if (!expectedUpdatedAt || expectedUpdatedAt !== booking.updated_at) throw new ApiError(409, "BOOKING_CONFLICT", "預約已更新，請重新整理後再確認。");
  if (booking.cancellation_requested_at && !booking.cancellation_reviewed_at) {
    throw new ApiError(409, "BOOKING_CANCELLATION_PENDING", "這筆預約已有待確認的取消申請，請至「取消申請」完成審核。");
  }
  const allowed = booking.status === "pending"
    ? ["confirmed", "rejected", "cancelled"]
    : booking.status === "confirmed" ? ["cancelled"] : [];
  if (!allowed.includes(nextStatus)) {
    throw new ApiError(409, "INVALID_BOOKING_TRANSITION", `目前狀態 ${booking.status} 無法變更為 ${nextStatus}。`);
  }

  const now = new Date().toISOString();
  const patch: Json = { status: nextStatus, admin_note: adminNote };
  if (nextStatus === "confirmed") {
    patch.confirmed_by = identity.lineUserId;
    patch.confirmed_at = now;
  } else if (nextStatus === "rejected") {
    patch.rejected_by = identity.lineUserId;
    patch.rejected_at = now;
  } else {
    patch.cancelled_by = identity.lineUserId;
    patch.cancelled_at = now;
  }

  const updated = await supabase.from("bookings").update(patch).eq("id", bookingId).eq("status", booking.status).eq("updated_at", booking.updated_at)
    .select("*, members!bookings_member_id_fkey(display_name, member_code)").single();
  if (updated.error) throw mapDatabaseError(updated.error);
  const hydrated = await hydrateBookings(supabase, [updated.data]);
  await audit(supabase, identity, "admin", `BOOKING_${nextStatus.toUpperCase()}`, "booking", bookingId, { previousStatus: booking.status });
  return { booking: hydrated[0] };
}

async function bookingRisk(supabase: SupabaseClient, identity: Identity, action: string, body: Json): Promise<Json> {
  if (!businessContext()) throw new ApiError(403,"FEATURE_DISABLED","此功能僅供已開通商家使用。");
  const member = action.startsWith("user.");
  const result = member
    ? await supabase.rpc("booking_no_show_status", {p_actor:identity.lineUserId})
    : await supabase.rpc("admin_booking_no_show", {p_actor:identity.lineUserId,p_action:action.split(".").pop(),p_body:body.policy || body});
  if (result.error) throw mapDatabaseError(result.error);
  return result.data || {restricted:false};
}

async function route(supabase: SupabaseClient, identity: Identity, clientType: ClientType, action: string, body: Json): Promise<Json> {
  if (clientType === "member") {
    const member = await requireJoinedMember(supabase, identity);
    if (action === "user.booking.risk.status") return await bookingRisk(supabase, identity, action, body);
    if (action === "user.booking.bootstrap") {
      const data=await userBootstrap(supabase,member,body);
      if(businessContext()) data.bookingRestriction=await bookingRisk(supabase,identity,"user.booking.risk.status",{});
      return data;
    }
    if (action === "user.booking.slots") return await generateSlots(supabase, body, member);
    if (action === "user.booking.create") return await userCreate(supabase, identity, member, body);
    if (action === "user.booking.update") return await userUpdate(supabase, identity, member, body);
    if (action === "user.booking.cancel") return await userCancel(supabase, identity, member, body);
    throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的會員預約操作。");
  }

  await authorizeAdmin(supabase, identity);
  if (action === "admin.booking.summary") return await adminBookingSummary(supabase, identity);
  if (action === "admin.booking.notifications.read") return await adminMarkBookingNotificationsRead(supabase, identity, body);
  if (["admin.booking.risk.get","admin.booking.risk.save","admin.booking.risk.revoke","admin.booking.risk.release"].includes(action)) return await bookingRisk(supabase,identity,action,body);
  if (action === "admin.booking.bootstrap") {
    const data=await adminBootstrap(supabase,body);
    if(businessContext()) data.noShowRisk=await bookingRisk(supabase,identity,"admin.booking.risk.get",{});
    return data;
  }
  if (action === "admin.booking.phone.create") return await adminCreatePhoneBooking(supabase, identity, body);
  if (action === "admin.booking.settings.save") return await adminSettingsSave(supabase, identity, body);
  if (action === "admin.booking.service.save") return await adminServiceSave(supabase, identity, body);
  if (action === "admin.booking.status.update") return await adminStatusUpdate(supabase, identity, body);
  throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的管理端預約操作。");
}

serveBusiness('booking-api',async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return response(origin, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支援 POST。" } }, 405);
  if (origin && !allowedOrigins().has(origin)) return response(origin, { ok: false, error: { code: "ORIGIN_DENIED", message: "不允許的來源。" } }, 403);

  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) throw new ApiError(413, "REQUEST_TOO_LARGE", "請求內容過大。");
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);

    const action = asText(body.action, 80);
    const clientType = asText(body.clientType, 20) as ClientType;
    if (!action) throw new ApiError(400, "ACTION_REQUIRED", "缺少操作名稱。");
    if (!["member", "admin"].includes(clientType)) throw new ApiError(400, "INVALID_CLIENT_TYPE", "不支援的操作端。");
    const expectedPrefix = clientType === "admin" ? "admin.booking." : "user.booking.";
    if (!action.startsWith(expectedPrefix)) throw new ApiError(403, "CLIENT_ACTION_MISMATCH", "操作端與功能不相符。");

    const idToken = asText(body.idToken, 5000);
    const testSessionToken = asText(body.testSessionToken, 200);
    if (!idToken && !(clientType === "member" && testSessionToken)) {
      throw new ApiError(401, "AUTH_REQUIRED", "請先使用 LINE 登入。");
    }

    const supabase = dbClient();
    if (clientType === "member") {
      const mode = await supabase.from("test_mode_settings")
        .select("maintenance_enabled,maintenance_message")
        .eq("id", true)
        .maybeSingle();
      if (mode.error) throw new ApiError(503, "TEST_MODE_CHECK_FAILED", "目前無法確認系統維護狀態。");
      if (mode.data?.maintenance_enabled && !testSessionToken) {
        throw new ApiError(503, "SYSTEM_MAINTENANCE", asText(mode.data.maintenance_message, 500) || "系統維護中，請稍後再試。");
      }
    }

    let identity: Identity;
    if (clientType === "member" && testSessionToken) {
      try {
        const testIdentity = await resolveTestSession(supabase, testSessionToken);
        identity = { lineUserId: testIdentity.lineUserId, displayName: testIdentity.displayName };
      } catch (error) {
        if (error instanceof TestModeAuthError) throw new ApiError(error.status, error.code, error.message);
        throw error;
      }
    } else {
      identity = await verifyLineIdToken(idToken, clientType);
    }

    await consumeRateLimit(supabase, identity, action);
    const data = await route(supabase, identity, clientType, action, body);
    return response(origin, { ok: true, status: 200, data });
  } catch (error) {
    return errorResponse(origin, error);
  }
});
