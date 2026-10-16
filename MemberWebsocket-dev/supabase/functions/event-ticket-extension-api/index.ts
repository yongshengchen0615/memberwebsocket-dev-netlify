import { bookingTicketUsageError, ticketBookingId } from "../_shared/booking-ticket-usage.ts";
import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { resolveUserTestIdentity, TestModeAuthError } from "../_shared/test-mode-auth.ts";

type Json = Record<string, unknown>;

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const MAX_REQUEST_BYTES = 20_000;

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function asText(value: unknown, max = 1000): string { return String(value ?? "").trim().slice(0, max); }
function allowedOrigins(): Set<string> {
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io").split(",").map((v) => v.trim()).filter(Boolean));
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
function json(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" } });
}
function db() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "資料服務尚未完成設定。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function channelId(kind: "event" | "admin"): string {
  const value = env(kind === "admin" ? "LINE_ADMIN_CHANNEL_ID" : "LINE_EVENT_CHANNEL_ID") || (kind === "admin" ? "2010791619" : "2010787602");
  if (!/^\d{5,30}$/.test(value)) throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 驗證設定尚未完成。");
  return value;
}
async function verifyLineIdToken(idToken: string, kind: "event" | "admin") {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: channelId(kind),
    createError: (status, code, message) => new ApiError(status, code, message),
  });
}
async function memberIdentity(supabase: ReturnType<typeof db>, body: Json) {
  try {
    const testIdentity = await resolveUserTestIdentity(supabase, asText(body.testSessionToken, 200));
    if (testIdentity) return { lineUserId: testIdentity.lineUserId, displayName: testIdentity.displayName };
  } catch (error) {
    if (error instanceof TestModeAuthError) throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
  return await verifyLineIdToken(asText(body.idToken, 10000), "event");
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function consumeRateLimit(supabase: ReturnType<typeof db>, principal: string, isWrite: boolean, cost: number) {
  const result = await supabase.rpc("consume_api_rate_limit", {
    p_principal_hash: await sha256(principal), p_is_write: isWrite, p_cost: cost, p_read_limit: 90, p_write_limit: 30,
  });
  if (result.error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。");
  if (!result.data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。");
}
async function requireAdmin(supabase: ReturnType<typeof db>, lineUserId: string) {
  await requireActiveAdminContract({
    supabase,
    identity: { lineUserId, displayName: "" },
    createError: (status, code, message) => new ApiError(status, code, message),
  });
}
async function requireActiveMember(supabase: ReturnType<typeof db>, lineUserId: string) {
  const result = await supabase.from("members").select("id,status,membership_status").eq("line_user_id", lineUserId).maybeSingle();
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "目前無法確認會員狀態。");
  if (!result.data || result.data.status !== "active" || result.data.membership_status !== "active") {
    throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先完成會員加入後再使用此功能。");
  }
  return result.data;
}
async function globalSetting(supabase: ReturnType<typeof db>) {
  const result = await supabase.from("event_ticket_settings").select("max_tickets_per_day,updated_at").eq("id", 1).maybeSingle();
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "無法讀取活動票券設定。");
  const maxTicketsPerDay = Number(result.data?.max_tickets_per_day ?? 1);
  return {
    maxTicketsPerDay,
    maxTicketsPerRedemption: maxTicketsPerDay,
    updatedAt: String(result.data?.updated_at || ""),
  };
}
function mapRpcError(error: unknown): ApiError {
  const bookingError = bookingTicketUsageError(error, (status, code, message) => new ApiError(status, code, message));
  if (bookingError) return bookingError as ApiError;
  const message = String((error as { message?: string })?.message || "");
  if (message.includes("MEMBERSHIP_REQUIRED")) return new ApiError(403, "MEMBERSHIP_REQUIRED", "請先完成會員加入後再使用此功能。");
  if (message.includes("CLAIM_NOT_FOUND")) return new ApiError(404, "CLAIM_NOT_FOUND", "找不到其中一張已領取票券。");
  if (message.includes("CLAIM_NOT_AVAILABLE")) return new ApiError(409, "CLAIM_NOT_AVAILABLE", "其中一張活動票券目前已無法使用，請更新後再試。");
  if (message.includes("EVENT_TICKET_DAILY_LIMIT_REACHED")) return new ApiError(409, "EVENT_TICKET_DAILY_LIMIT_REACHED", "今日活動票券使用張數已達上限，請於明日再使用。");
  if (message.includes("EVENT_TICKET_BATCH_LIMIT_EXCEEDED")) return new ApiError(409, "EVENT_TICKET_BATCH_LIMIT_EXCEEDED", "活動票券使用張數超過目前允許範圍。");
  if (message.includes("INVALID_EVENT_TICKET_BATCH")) return new ApiError(400, "INVALID_EVENT_TICKET_BATCH", "請選擇 1–50 張不同的活動票券。");
  if (message.includes("INVALID_REQUEST_ID")) return new ApiError(400, "INVALID_REQUEST_ID", "操作識別碼格式不正確。");
  if (message.includes("EVENT_TICKET_NOT_AVAILABLE")) return new ApiError(409, "EVENT_TICKET_NOT_AVAILABLE", "其中一張活動票券目前無法使用。");
  if (message.includes("EVENT_NOT_STARTED")) return new ApiError(409, "EVENT_NOT_STARTED", "其中一張活動票券尚未到可使用日期。");
  if (message.includes("EVENT_ENDED")) return new ApiError(409, "EVENT_ENDED", "其中一張活動票券已超過使用期限。");
  if (message.includes("TIER_NOT_ALLOWED")) return new ApiError(403, "TIER_NOT_ALLOWED", "目前會員等級不適用其中一張票券。");
  if (message.includes("LOCATION_REQUIRED")) return new ApiError(400, "LOCATION_REQUIRED", "核銷前請允許定位並取得目前位置。");
  if (message.includes("LOCATION_INVALID")) return new ApiError(400, "LOCATION_INVALID", "定位精度不足或資料已過期，請重新定位。");
  if (message.includes("LOCATION_OUT_OF_RANGE")) return new ApiError(403, "LOCATION_OUT_OF_RANGE", "目前不在其中一張票券的核銷範圍內。");
  return new ApiError(500, "DATABASE_ERROR", "資料庫暫時無法完成操作。");
}
async function memberSetting(origin: string | null, body: Json) {
  const supabase = db();
  const identity = await memberIdentity(supabase, body);
  await consumeRateLimit(supabase, identity.lineUserId, false, 1);
  await requireActiveMember(supabase, identity.lineUserId);
  return json(origin, { ok: true, status: 200, data: await globalSetting(supabase) });
}
async function todayUsable(origin: string | null, body: Json) {
  const supabase = db();
  const identity = await memberIdentity(supabase, body);
  await consumeRateLimit(supabase, identity.lineUserId, false, 1);
  await requireActiveMember(supabase, identity.lineUserId);
  const result = await supabase.rpc("count_today_usable_event_tickets", { p_line_user_id: identity.lineUserId });
  if (result.error) throw mapRpcError(result.error);
  return json(origin, { ok: true, status: 200, data: result.data || {} });
}
async function redeemTickets(origin: string | null, body: Json) {
  const rawClaimIds = Array.isArray(body.claimIds) ? body.claimIds : [];
  const claimIds = rawClaimIds.map((v) => asText(v, 120)).filter(Boolean);
  if (claimIds.length < 1 || claimIds.length > 50 || claimIds.length !== rawClaimIds.length || new Set(claimIds).size !== claimIds.length) {
    throw new ApiError(400, "INVALID_EVENT_TICKET_BATCH", "請選擇 1–50 張不同的活動票券。");
  }
  const requestId = asText(body.requestId, 120);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) throw new ApiError(400, "INVALID_REQUEST_ID", "操作識別碼格式不正確。");
  const location = body.location && typeof body.location === "object" && !Array.isArray(body.location) ? body.location as Json : null;
  const supabase = db();
  const identity = await memberIdentity(supabase, body);
  const member = await requireActiveMember(supabase, identity.lineUserId);
  const setting = await globalSetting(supabase);
  if (!(await hasCurrentTermsConsent(supabase, member.id))) {
    throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先至會員卡同意最新版會員條款。");
  }
  await consumeRateLimit(supabase, identity.lineUserId, true, claimIds.length);
  const rpc = await supabase.rpc("redeem_member_tickets_for_booking_request", {
    p_line_user_id: identity.lineUserId,
    p_booking_id: ticketBookingId(body.bookingId, (status, code, message) => new ApiError(status, code, message)),
    p_kind: "event", p_refs: claimIds, p_request_id: requestId, p_location: location,
  });
  if (rpc.error) throw mapRpcError(rpc.error);
  const realtime = await supabase.from("realtime_events").insert([
    { scope: "event", event_type: "user.event.tickets.redeem" },
    { scope: "admin", event_type: "user.event.tickets.redeem" },
  ]);
  if (realtime.error) {
    console.error(JSON.stringify({ event: "event_ticket_batch_realtime_failed", code: realtime.error.code || "" }));
  }
  const data = rpc.data && typeof rpc.data === "object" ? rpc.data as Json : {};
  return json(origin, { ok: true, status: 200, data: {
    ...data,
    maxTicketsPerDay: setting.maxTicketsPerDay,
  } });
}
async function adminSetting(origin: string | null, body: Json) {
  const identity = await verifyLineIdToken(asText(body.idToken, 10000), "admin");
  const supabase = db();
  await consumeRateLimit(supabase, identity.lineUserId, false, 1);
  await requireAdmin(supabase, identity.lineUserId);
  return json(origin, { ok: true, status: 200, data: await globalSetting(supabase) });
}
async function saveAdminSetting(origin: string | null, body: Json) {
  const identity = await verifyLineIdToken(asText(body.idToken, 10000), "admin");
  const supabase = db();
  await consumeRateLimit(supabase, identity.lineUserId, true, 1);
  await requireAdmin(supabase, identity.lineUserId);
  const maxTickets = Number(body.maxTicketsPerDay ?? body.maxTicketsPerRedemption);
  if (!Number.isInteger(maxTickets) || maxTickets < 0 || maxTickets > 50) {
    throw new ApiError(400, "INVALID_TICKET_USE_LIMIT", "活動票券使用設定必須是 0–50 的整數；0 代表不限張數。");
  }
  const expectedUpdatedAt = asText(body.expectedUpdatedAt, 100);
  const nextRow = {
    id: 1,
    max_tickets_per_day: maxTickets,
    updated_by: identity.lineUserId,
    updated_at: new Date().toISOString(),
  };
  let saved;
  if (expectedUpdatedAt) {
    saved = await supabase.from("event_ticket_settings")
      .update(nextRow)
      .eq("id", 1)
      .eq("updated_at", expectedUpdatedAt)
      .select("max_tickets_per_day,updated_at")
      .maybeSingle();
  } else {
    saved = await supabase.from("event_ticket_settings")
      .upsert(nextRow, { onConflict: "id" })
      .select("max_tickets_per_day,updated_at")
      .single();
  }
  if (saved.error) throw new ApiError(500, "DATABASE_ERROR", "無法儲存活動票券設定。");
  if (!saved.data) throw new ApiError(409, "CONFLICT", "活動票券設定已被其他管理者更新，請重新整理後再試。");
  await supabase.from("audit_logs").insert({
    audit_id: `AUD-${crypto.randomUUID().replaceAll("-", "")}`,
    actor_line_user_id: identity.lineUserId,
    actor_role: "admin",
    action: "admin.event-ticket.settings.save",
    target_type: "event_ticket_settings",
    target_id: "global",
    result: "success",
    detail: { maxTicketsPerDay: maxTickets },
  });
  const realtime = await supabase.from("realtime_events").insert([
    { scope: "event", event_type: "admin.event-ticket.settings.save" },
    { scope: "admin", event_type: "admin.event-ticket.settings.save" },
  ]);
  if (realtime.error) {
    console.error(JSON.stringify({ event: "event_ticket_setting_realtime_failed", code: realtime.error.code || "" }));
  }
  return json(origin, { ok: true, status: 200, data: {
    maxTicketsPerDay: Number(saved.data.max_tickets_per_day ?? 1),
    maxTicketsPerRedemption: Number(saved.data.max_tickets_per_day ?? 1),
    updatedAt: String(saved.data.updated_at || ""),
  } });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  try {
    if (origin && !allowedOrigins().has(origin)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未被允許使用會員 API。");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "不支援的 HTTP method。");
    const raw = await request.text();
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body 大小不合法。");
    let body: Json;
    try { body = JSON.parse(raw); } catch { throw new ApiError(400, "INVALID_JSON", "Request body 必須是 JSON。"); }
    if (!body || Array.isArray(body) || typeof body !== "object") throw new ApiError(400, "INVALID_REQUEST", "Request body 格式不合法。");
    const operation = asText(body.operation, 60);
    if (operation === "member.settings.get") return await memberSetting(origin, body);
    if (operation === "member.today-usable") return await todayUsable(origin, body);
    if (operation === "member.redeem") return await redeemTickets(origin, body);
    if (operation === "admin.settings.get") return await adminSetting(origin, body);
    if (operation === "admin.settings.save") return await saveAdminSetting(origin, body);
    throw new ApiError(404, "OPERATION_NOT_FOUND", "不支援的操作。");
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "服務暫時無法完成操作。");
    return json(origin, { ok: false, status: apiError.status, error: { code: apiError.code, message: apiError.message } }, apiError.status);
  }
});
