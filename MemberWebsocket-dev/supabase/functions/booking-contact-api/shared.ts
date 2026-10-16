import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

export type Json = Record<string, unknown>;
export type Identity = { lineUserId: string; displayName: string };
export type ClientType = "member" | "admin";

export const MAX_REQUEST_BYTES = 30_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;
const WRITE_ACTIONS = new Set(["user.booking.create", "user.booking.update"]);

export class ApiError extends Error {
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

export function env(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

export function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function allowedOrigins(): Set<string> {
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
}

export function corsHeaders(origin: string | null): HeadersInit {
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

export function originAllowed(origin: string | null): boolean {
  return !origin || allowedOrigins().has(origin);
}

export function response(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

export function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function channelIdFor(clientType: ClientType): string {
  const envName = clientType === "admin" ? "LINE_ADMIN_CHANNEL_ID" : "LINE_MEMBER_CHANNEL_ID";
  return env(envName) || (clientType === "admin" ? "2010791619" : "2010787602");
}

export async function verifyLineIdToken(idToken: string, clientType: ClientType): Promise<Identity> {
  const channelId = channelIdFor(clientType);
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: channelId,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function consumeRateLimit(supabase: SupabaseClient, identity: Identity, action: string): Promise<void> {
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

export async function requireJoinedMember(supabase: SupabaseClient, identity: Identity): Promise<any> {
  const result = await supabase.from("members").select("*").eq("line_user_id", identity.lineUserId).maybeSingle();
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "會員資料暫時無法讀取。");
  const member = result.data;
  if (!member || member.membership_status !== "active") {
    throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先加入會員並完成會員資料後再使用預約功能。");
  }
  if (member.status !== "active") throw new ApiError(403, "MEMBER_DISABLED", "此會員目前已停用，無法預約。");
  if (!(await hasCurrentTermsConsent(supabase, member.id))) throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先至會員卡同意新版條款。");
  return member;
}

export async function authorizeAdmin(supabase: SupabaseClient, identity: Identity): Promise<any> {
  return await requireActiveAdminContract({
    supabase,
    identity,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}
