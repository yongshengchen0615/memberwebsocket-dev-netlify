import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

type Json = Record<string, unknown>;
type ClientType = "admin" | "event";

const MAX_REQUEST_BYTES = 30_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;

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
  return (Deno.env.get(name) || "").trim();
}

function allowedOrigins(): Set<string> {
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
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
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(origin: string | null, error: unknown): Response {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "INTERNAL_ERROR", "活動連結服務暫時無法完成操作。");
  return json(origin, {
    ok: false,
    status: apiError.status,
    error: { code: apiError.code, message: apiError.message, details: apiError.details },
  }, apiError.status);
}

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function requireText(value: unknown, label: string, max = 100): string {
  const text = asText(value, max);
  if (!text) throw new ApiError(400, "INVALID_INPUT", `${label}不可空白。`);
  return text;
}

function activityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 2048 || /\s/.test(raw)) {
    throw new ApiError(400, "INVALID_ACTIVITY_URL", "活動連結格式不正確。");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(400, "INVALID_ACTIVITY_URL", "活動連結格式不正確。");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new ApiError(400, "INVALID_ACTIVITY_URL", "活動連結必須使用 https:// 網址。");
  }
  return parsed.toString();
}

function activityLinkName(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (raw.length > 120 || /[\u0000-\u001F\u007F]/.test(raw)) {
    throw new ApiError(400, "INVALID_ACTIVITY_LINK_NAME", "連結名稱最多 120 個字，且不可包含控制字元。");
  }
  return raw;
}

function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function expectedChannelId(clientType: ClientType): string {
  const envName = clientType === "admin" ? "LINE_ADMIN_CHANNEL_ID" : "LINE_EVENT_CHANNEL_ID";
  const fallback = clientType === "admin" ? "2010791619" : "2010787602";
  const value = env(envName) || fallback;
  if (!/^\d{5,30}$/.test(value)) throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 驗證設定尚未完成。");
  return value;
}

async function verifyLineIdToken(idToken: string, clientType: ClientType): Promise<{ lineUserId: string; displayName: string }> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: expectedChannelId(clientType),
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function consumeRateLimit(supabase: SupabaseClient, principal: string, isWrite: boolean): Promise<void> {
  const result = await supabase.rpc("consume_api_rate_limit", {
    p_principal_hash: await crypto.subtle.digest("SHA-256", new TextEncoder().encode(principal))
      .then((digest) => Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("")),
    p_is_write: isWrite,
    p_cost: 1,
    p_read_limit: READ_LIMIT,
    p_write_limit: WRITE_LIMIT,
  });
  if (result.error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。");
  if (!result.data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。");
}

async function authorizeAdmin(supabase: SupabaseClient, lineUserId: string): Promise<any> {
  return await requireActiveAdminContract({
    supabase,
    identity: { lineUserId, displayName: "" },
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function requireMember(supabase: SupabaseClient, lineUserId: string): Promise<any> {
  const result = await supabase.from("members").select("id,line_user_id,status,membership_status").eq("line_user_id", lineUserId).maybeSingle();
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "資料庫暫時無法完成操作。");
  if (!result.data || result.data.membership_status !== "active") {
    throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先完成會員加入後再使用此功能。");
  }
  if (result.data.status !== "active") throw new ApiError(403, "MEMBER_DISABLED", "此會員目前已停用。");
  if (!(await hasCurrentTermsConsent(supabase, result.data.id))) throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先至會員卡同意新版條款。");
  return result.data;
}

function linkMap(rows: any[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [String(row.event_ticket_id), String(row.activity_url || "")]));
}

function linkNameMap(rows: any[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [String(row.event_ticket_id), String(row.activity_link_name || "")]));
}

function linkPayload(rows: any[]): Json {
  return {
    activityLinks: linkMap(rows),
    activityLinkNames: linkNameMap(rows),
  };
}

async function adminList(supabase: SupabaseClient): Promise<Json> {
  const result = await supabase
    .from("event_tickets")
    .select("event_ticket_id,activity_url,activity_link_name")
    .is("deleted_at", null);
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "活動連結資料暫時無法讀取。");
  return linkPayload(result.data || []);
}

async function adminSave(supabase: SupabaseClient, actor: string, body: Json): Promise<Json> {
  const eventTicketId = requireText(body.eventTicketId, "活動票券識別", 120);
  const nextUrl = activityUrl(body.activityUrl);
  const requestedName = activityLinkName(body.activityLinkName);
  const nextName = nextUrl ? requestedName : "";

  const current = await supabase
    .from("event_tickets")
    .select("id,event_ticket_id,activity_url,activity_link_name")
    .eq("event_ticket_id", eventTicketId)
    .is("deleted_at", null)
    .maybeSingle();
  if (current.error) throw new ApiError(500, "DATABASE_ERROR", "活動連結資料暫時無法讀取。");
  if (!current.data) throw new ApiError(404, "EVENT_TICKET_NOT_FOUND", "找不到指定活動票券。");

  const currentUrl = String(current.data.activity_url || "");
  const currentName = String(current.data.activity_link_name || "");

  if (Object.prototype.hasOwnProperty.call(body, "expectedActivityUrl")) {
    const expected = activityUrl(body.expectedActivityUrl);
    if (expected !== currentUrl) throw new ApiError(409, "CONFLICT", "活動連結已被其他管理者更新，請重新整理後再試。");
  }
  if (Object.prototype.hasOwnProperty.call(body, "expectedActivityLinkName")) {
    const expectedName = activityLinkName(body.expectedActivityLinkName);
    if (expectedName !== currentName) throw new ApiError(409, "CONFLICT", "活動連結名稱已被其他管理者更新，請重新整理後再試。");
  }

  if (currentUrl === nextUrl && currentName === nextName) {
    return { eventTicketId, activityUrl: nextUrl, activityLinkName: nextName, changed: false };
  }

  const updated = await supabase
    .from("event_tickets")
    .update({ activity_url: nextUrl, activity_link_name: nextName })
    .eq("id", current.data.id)
    .eq("activity_url", currentUrl)
    .eq("activity_link_name", currentName)
    .select("event_ticket_id,activity_url,activity_link_name")
    .maybeSingle();
  if (updated.error) throw new ApiError(500, "DATABASE_ERROR", "活動連結暫時無法儲存。");
  if (!updated.data) throw new ApiError(409, "CONFLICT", "活動連結已被其他管理者更新，請重新整理後再試。");

  await supabase.from("audit_logs").insert({
    audit_id: `AUD-${crypto.randomUUID().replaceAll("-", "")}`,
    actor_line_user_id: actor,
    actor_role: "admin",
    action: "EVENT_TICKET_ACTIVITY_URL_CHANGED",
    target_type: "event_ticket",
    target_id: eventTicketId,
    result: "success",
    detail: {
      hadActivityUrl: Boolean(currentUrl),
      hasActivityUrl: Boolean(nextUrl),
      linkNameChanged: currentName !== nextName,
    },
  });
  await supabase.from("realtime_events").insert([
    { scope: "event", event_type: "admin.event-ticket-link.save" },
    { scope: "admin", event_type: "admin.event-ticket-link.save" },
  ]);
  return {
    eventTicketId,
    activityUrl: String(updated.data.activity_url || ""),
    activityLinkName: String(updated.data.activity_link_name || ""),
    changed: true,
  };
}

async function memberList(supabase: SupabaseClient, member: any, body: Json): Promise<Json> {
  const ids = Array.isArray(body.eventTicketIds)
    ? [...new Set(body.eventTicketIds.map((value) => asText(value, 120)).filter(Boolean))].slice(0, 100)
    : [];
  if (!ids.length) return { activityLinks: {}, activityLinkNames: {} };

  const rowsResult = await supabase
    .from("event_tickets")
    .select("id,event_ticket_id,activity_url,activity_link_name,status,deleted_at")
    .in("event_ticket_id", ids);
  if (rowsResult.error) throw new ApiError(500, "DATABASE_ERROR", "活動連結資料暫時無法讀取。");
  const rows = rowsResult.data || [];
  if (!rows.length) return { activityLinks: {}, activityLinkNames: {} };

  const internalIds = rows.map((row) => row.id);
  const claims = await supabase
    .from("event_ticket_claims")
    .select("event_ticket_id")
    .eq("member_id", member.id)
    .in("event_ticket_id", internalIds);
  if (claims.error) throw new ApiError(500, "DATABASE_ERROR", "活動票券資格暫時無法確認。");
  const claimedIds = new Set((claims.data || []).map((row) => String(row.event_ticket_id)));

  const allowedRows = rows.filter((row) =>
    (row.status === "active" && !row.deleted_at) || claimedIds.has(String(row.id))
  );
  return linkPayload(allowedRows);
}

async function handleRequest(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (origin && !allowedOrigins().has(origin)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未被允許使用活動連結服務。");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method === "GET") return json(origin, { ok: true, status: 200, data: { service: "event-ticket-links", version: "1.1.0" } });
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "不支援的 HTTP method。");

    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);

    const action = asText(body.action, 80);
    const requestedClientType = asText(body.clientType, 20);
    const idToken = asText(body.idToken, 10000);
    const clientType: ClientType = action.startsWith("admin.") ? "admin" : action.startsWith("user.") ? "event" : (() => { throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的 API action。"); })();
    if (requestedClientType && requestedClientType !== clientType) throw new ApiError(400, "CLIENT_TYPE_MISMATCH", "Client type 與 API action 不一致。");
    if (!idToken) throw new ApiError(401, "AUTH_REQUIRED", "需要 LINE 登入。");

    const identity = await verifyLineIdToken(idToken, clientType);
    const supabase = dbClient();
    const isWrite = action === "admin.event-ticket-links.save";
    await consumeRateLimit(supabase, identity.lineUserId, isWrite);

    let data: Json;
    if (clientType === "admin") {
      await authorizeAdmin(supabase, identity.lineUserId);
      if (action === "admin.event-ticket-links.list") data = await adminList(supabase);
      else if (action === "admin.event-ticket-links.save") data = await adminSave(supabase, identity.lineUserId, body);
      else throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的 API action。");
    } else {
      const member = await requireMember(supabase, identity.lineUserId);
      if (action === "user.event-ticket-links.list") data = await memberList(supabase, member, body);
      else throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的 API action。");
    }
    return json(origin, { ok: true, status: 200, data }, 200);
  } catch (error) {
    return errorResponse(origin, error);
  }
}

export default { fetch: handleRequest };

