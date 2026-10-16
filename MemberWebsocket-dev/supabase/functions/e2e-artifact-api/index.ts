import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";

type Json = Record<string, unknown>;

const BUCKET = "e2e-failure-artifacts";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 300;
const SURFACES = new Set(["admin", "member", "points", "event", "calendar", "booking"]);

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

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function asText(value: unknown, max = 1000): string { return String(value ?? "").trim().slice(0, max); }
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
function failReply(origin: string | null, error: unknown): Response {
  const e = error instanceof ApiError
    ? error
    : new ApiError(500, "E2E_ARTIFACT_ERROR", "E2E 失敗快照服務暫時無法完成操作。");
  return reply(origin, { ok: false, status: e.status, error: { code: e.code, message: e.message, details: e.details } }, e.status);
}
function db() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function adminChannelId(): string {
  const value = env("LINE_ADMIN_CHANNEL_ID") || "2010791619";
  if (!/^\d{5,30}$/.test(value)) throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 管理端驗證設定尚未完成。");
  return value;
}
async function verifyAdminIdentity(idToken: string): Promise<{ lineUserId: string }> {
  const identity = await verifyLineIdTokenContract({
    idToken: asText(idToken, 10_000), expectedChannelId: adminChannelId(),
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
  return { lineUserId: identity.lineUserId };
}
async function authorizeAdmin(supabase: any, identity: { lineUserId: string }): Promise<void> {
  await requireActiveAdminContract({
    supabase, identity: { lineUserId: identity.lineUserId, displayName: '' },
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function authorizeTestSession(supabase: any, rawToken: string): Promise<void> {
  const token = asText(rawToken, 200);
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new ApiError(401, "TEST_SESSION_INVALID", "測試登入已失效，請重新選擇測試帳號。");
  const tokenHash = await sha256Hex(token);
  const [settingsResult, sessionResult] = await Promise.all([
    supabase.from("test_mode_settings").select("maintenance_enabled,allow_pc_test_login,allow_mobile_test_login").eq("id", true).maybeSingle(),
    supabase.from("test_login_sessions").select("id,member_id,device_class,expires_at,revoked_at").eq("token_hash", tokenHash).maybeSingle(),
  ]);
  if (settingsResult.error || sessionResult.error) throw new ApiError(503, "TEST_SESSION_UNAVAILABLE", "目前無法確認測試登入狀態。");
  if (!settingsResult.data?.maintenance_enabled) throw new ApiError(403, "TEST_LOGIN_DISABLED", "目前未啟用系統維護測試登入。");
  const session = sessionResult.data;
  const allowed = session?.device_class === "mobile"
    ? settingsResult.data?.allow_mobile_test_login === true
    : session?.device_class === "pc"
      ? settingsResult.data?.allow_pc_test_login === true
      : false;
  const expiresAt = session?.expires_at ? new Date(session.expires_at).getTime() : 0;
  if (!session || session.revoked_at || !allowed || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ApiError(401, "TEST_SESSION_EXPIRED", "測試登入已過期，請重新選擇測試帳號。");
  }
  const member = await supabase.from("members").select("id,is_test_account,status,membership_status").eq("id", session.member_id).maybeSingle();
  if (member.error) throw new ApiError(503, "TEST_SESSION_UNAVAILABLE", "目前無法確認測試登入狀態。");
  if (!member.data || member.data.is_test_account !== true || member.data.status !== "active" || member.data.membership_status !== "active") {
    throw new ApiError(403, "TEST_ACCOUNT_UNAVAILABLE", "選擇的測試帳號目前無法使用。");
  }
}
function safeSegment(value: unknown, fallback: string, max = 80): string {
  const normalized = asText(value, max).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max);
  return normalized || fallback;
}
function validObjectPath(path: string): boolean { return /^runs\/[A-Za-z0-9._-]{1,240}\.webp$/.test(path); }
function numberField(value: FormDataEntryValue | null, max: number): number {
  const parsed = Math.trunc(Number(String(value ?? "0")));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, parsed)) : 0;
}
async function authorizeUpload(supabase: any, form: FormData): Promise<"admin" | "member"> {
  const actorType = asText(form.get("actorType"), 20);
  if (actorType === "admin") {
    const identity = await verifyAdminIdentity(asText(form.get("idToken"), 10_000));
    await authorizeAdmin(supabase, identity);
    return "admin";
  }
  if (actorType === "member") {
    await authorizeTestSession(supabase, asText(form.get("testSessionToken"), 200));
    return "member";
  }
  throw new ApiError(400, "INVALID_ACTOR_TYPE", "E2E 快照上傳來源不正確。");
}
async function uploadArtifact(origin: string | null, request: Request): Promise<Response> {
  const form = await request.formData();
  const supabase = db();
  const actorType = await authorizeUpload(supabase, form);
  const surface = asText(form.get("surface"), 20).toLowerCase();
  if (!SURFACES.has(surface)) throw new ApiError(400, "INVALID_SURFACE", "E2E 快照頁面類型不正確。");
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "ARTIFACT_FILE_REQUIRED", "缺少 E2E 失敗快照。");
  if (file.type !== "image/webp") throw new ApiError(415, "ARTIFACT_TYPE_INVALID", "E2E 快照只接受 WebP。");
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new ApiError(413, "ARTIFACT_TOO_LARGE", "E2E 快照超過 2 MB 上限。");
  const rootRunId = safeSegment(form.get("rootRunId"), "adhoc", 72);
  const caseKey = safeSegment(form.get("caseKey"), "case", 80);
  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const unique = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const objectName = [rootRunId, actorType, surface, caseKey, stamp + "-" + unique]
    .map((part) => safeSegment(part, "x", 80)).join("--") + ".webp";
  const path = "runs/" + objectName;
  const uploaded = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: "image/webp",
    cacheControl: "60",
    upsert: false,
  });
  if (uploaded.error) throw new ApiError(503, "ARTIFACT_UPLOAD_FAILED", "E2E 失敗快照上傳失敗。", uploaded.error.message || null);
  const width = numberField(form.get("width"), 10_000);
  const height = numberField(form.get("height"), 10_000);
  return reply(origin, {
    ok: true,
    status: 201,
    data: { screenshot: {
      bucket: BUCKET,
      path,
      mimeType: "image/webp",
      size: file.size,
      width,
      height,
      capturedAt,
      retentionDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    } },
  }, 201);
}
async function signedView(origin: string | null, body: Json): Promise<Response> {
  const supabase = db();
  const identity = await verifyAdminIdentity(asText(body.idToken, 10_000));
  await authorizeAdmin(supabase, identity);
  const path = asText(body.path, 300);
  if (!validObjectPath(path)) throw new ApiError(400, "INVALID_ARTIFACT_PATH", "E2E 快照路徑不正確。");
  const signed = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) throw new ApiError(404, "ARTIFACT_NOT_FOUND", "E2E 失敗快照不存在或已超過保留期限。");
  return reply(origin, { ok: true, status: 200, data: {
    signedUrl: signed.data.signedUrl,
    expiresIn: SIGNED_URL_TTL_SECONDS,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  } });
}
Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return failReply(origin, new ApiError(405, "METHOD_NOT_ALLOWED", "只支援 POST。"));
  if (origin && !allowedOrigins().has(origin)) return failReply(origin, new ApiError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未被允許使用 E2E 快照服務。"));
  try {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) return await uploadArtifact(origin, request);
    let body: Json = {};
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Json;
    } catch {
      throw new ApiError(400, "INVALID_JSON", "請求內容必須是有效 JSON。");
    }
    const action = asText(body.action, 80);
    if (action === "admin.e2e-artifact.signed-url") return await signedView(origin, body);
    throw new ApiError(404, "ACTION_NOT_FOUND", "找不到指定的 E2E 快照操作。");
  } catch (error) {
    return failReply(origin, error);
  }
});
