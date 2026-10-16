import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract } from "../_shared/auth-contract.ts";
import { resolveUserTestIdentity, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

type Json = Record<string, unknown>;
type Identity = { lineUserId: string; displayName: string };
type ClientType = "member" | "event" | "points" | "booking";

const MAX_REQUEST_BYTES = 20_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 20;

class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function asText(value: unknown, max = 1000): string { return String(value ?? "").trim().slice(0, max); }
function allowedOrigins(): Set<string> {
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io").split(",").map((v) => v.trim()).filter(Boolean));
}
function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins().has(origin) ? origin : "",
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
function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function channelId(clientType: ClientType): string {
  if (clientType === "booking") return env("LINE_BOOKING_CHANNEL_ID") || "2010787602";
  if (clientType === "points") return env("LINE_POINTS_CHANNEL_ID") || "2010787602";
  if (clientType === "event") return env("LINE_EVENT_CHANNEL_ID") || "2010787602";
  return env("LINE_MEMBER_CHANNEL_ID") || "2010787602";
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function consumeRateLimit(supabase: SupabaseClient, identity: Identity, write: boolean): Promise<void> {
  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_principal_hash: await sha256(identity.lineUserId),
    p_is_write: write,
    p_cost: 1,
    p_read_limit: READ_LIMIT,
    p_write_limit: WRITE_LIMIT,
  });
  if (error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。");
  if (!data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。");
}
async function resolveIdentity(supabase: SupabaseClient, body: Json, clientType: ClientType): Promise<Identity> {
  try {
    const testIdentity = await resolveUserTestIdentity(supabase, asText(body.testSessionToken, 200));
    if (testIdentity) {
      if (testIdentity.surface !== clientType) throw new ApiError(403, "TEST_SESSION_SURFACE_MISMATCH", "測試登入與目前功能不相符。");
      return { lineUserId: testIdentity.lineUserId, displayName: testIdentity.displayName };
    }
    return await verifyLineIdTokenContract({
      idToken: asText(body.idToken, 10_000),
      expectedChannelId: channelId(clientType),
      createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
    }) as Identity;
  } catch (error) {
    if (error instanceof TestModeAuthError) throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}
async function requireMember(supabase: SupabaseClient, identity: Identity): Promise<any> {
  const result = await supabase
    .from("members")
    .select("id,line_user_id,display_name,member_code,status,membership_status,invite_code,is_test_account")
    .eq("line_user_id", identity.lineUserId)
    .maybeSingle();
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "會員資料暫時無法讀取。");
  const member = result.data;
  if (!member || member.status !== "active" || member.membership_status !== "active") {
    throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先完成會員申請。");
  }
  if (!await hasCurrentTermsConsent(supabase, member.id)) {
    throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先同意目前有效的會員條款。");
  }
  return member;
}
function maskName(value: unknown): string {
  const text = asText(value, 120);
  if (!text) return "會員";
  const chars = Array.from(text);
  if (chars.length === 1) return chars[0];
  if (chars.length === 2) return chars[0] + "○";
  return chars[0] + "○".repeat(Math.min(chars.length - 2, 3)) + chars[chars.length - 1];
}
function mapDatabaseError(error: unknown): ApiError {
  const raw = error as { message?: string; details?: string; code?: string };
  const message = String(raw?.message || "") + " " + String(raw?.details || "");
  const rules: Array<[string, number, string, string]> = [
    ["FRIEND_NOT_FOUND",404,"FRIEND_NOT_FOUND","找不到可加入的好友，請確認會員編號或邀請碼。"],
    ["SELF_FRIEND_NOT_ALLOWED",409,"SELF_FRIEND_NOT_ALLOWED","不可加入自己為好友。"],
    ["FRIEND_BLOCKED",403,"FRIEND_BLOCKED","目前無法建立此好友關係。"],
    ["FRIEND_ACCEPT_DENIED",403,"FRIEND_ACCEPT_DENIED","只有收到邀請的好友可以接受。"],
    ["INVALID_INVITE_CODE",400,"INVALID_INVITE_CODE","邀請碼格式不正確。"],
    ["INVITE_CODE_NOT_FOUND",404,"INVITE_CODE_NOT_FOUND","找不到可使用的邀請碼。"],
    ["SELF_REFERRAL_NOT_ALLOWED",409,"SELF_REFERRAL_NOT_ALLOWED","不可使用自己的邀請碼。"],
    ["REFERRAL_CYCLE_NOT_ALLOWED",409,"REFERRAL_CYCLE_NOT_ALLOWED","此邀請關係不符合規則。"],
    ["REFERRAL_ALREADY_BOUND",409,"REFERRAL_ALREADY_BOUND","此會員已綁定其他邀請關係。"],
    ["REFERRAL_WINDOW_CLOSED",409,"REFERRAL_WINDOW_CLOSED","邀請碼綁定期限已過。"],
    ["REFERRAL_REWARD_TEMPLATE_MISSING",503,"REFERRAL_REWARD_UNAVAILABLE","管理員尚未設定好友邀請票券。"],
    ["REFERRAL_REWARD_UNAVAILABLE",503,"REFERRAL_REWARD_UNAVAILABLE","管理員尚未設定好友邀請票券。"],
    ["REFERRAL_REWARD_SOLD_OUT",409,"REFERRAL_REWARD_SOLD_OUT","好友邀請票券已達發放上限。"],
    ["REFERRAL_REWARD_NOT_ELIGIBLE",403,"REFERRAL_REWARD_NOT_ELIGIBLE","邀請人的會員等級不符合好友邀請票券資格。"],
    ["TRANSFER_RECEIVER_NOT_FOUND",404,"TRANSFER_RECEIVER_NOT_FOUND","找不到可收取點數的會員。"],
    ["TRANSFER_SELF_NOT_ALLOWED",409,"TRANSFER_SELF_NOT_ALLOWED","不可轉贈點數給自己。"],
    ["INVALID_TRANSFER_AMOUNT",400,"INVALID_TRANSFER_AMOUNT","轉贈點數必須是大於 0 的整數。"],
    ["INSUFFICIENT_POINTS",409,"INSUFFICIENT_POINTS","目前點數不足。"],
    ["POINT_CARD_NOT_FOUND",404,"POINT_CARD_NOT_FOUND","找不到集點卡。"],
    ["POINT_CARD_NOT_AVAILABLE",409,"POINT_CARD_NOT_AVAILABLE","此集點卡目前不可轉贈。"],
    ["POINT_CARD_EXPIRED",409,"POINT_CARD_EXPIRED","此集點卡已過期。"],
    ["REQUEST_ID_CONFLICT",409,"REQUEST_ID_CONFLICT","同一操作識別不可套用不同內容。"],
    ["INVALID_REQUEST_ID",400,"INVALID_REQUEST_ID","操作識別格式不正確。"],
    ["MEMBERSHIP_REQUIRED",403,"MEMBERSHIP_REQUIRED","會員目前無法使用此功能。"],
  ];
  for (const [needle,status,code,userMessage] of rules) {
    if (message.includes(needle)) return new ApiError(status,code,userMessage);
  }
  console.error(JSON.stringify({ event: "member_growth_db_error", code: raw?.code || "", message: String(raw?.message || "").slice(0,300) }));
  return new ApiError(500, "DATABASE_ERROR", "目前無法完成會員操作。");
}

async function todayUsable(supabase: SupabaseClient, identity: Identity): Promise<Json> {
  const result = await supabase.rpc("count_today_usable_event_tickets", { p_line_user_id: identity.lineUserId });
  if (result.error) throw mapDatabaseError(result.error);
  return (result.data && typeof result.data === "object") ? result.data as Json : { todayUsableCount: 0 };
}
async function lineOfficialAccount(supabase: SupabaseClient): Promise<Json> {
  const tokenResult = await supabase.rpc("get_line_messaging_token");
  const token = tokenResult.error ? "" : asText(tokenResult.data, 10_000);
  if (!token) throw new ApiError(503, "LINE_OFFICIAL_ACCOUNT_UNAVAILABLE", "LINE 官方帳號入口尚未設定完成。");

  let infoResponse: Response;
  try {
    infoResponse = await fetch("https://api.line.me/v2/bot/info", {
      headers: { "Authorization": "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(503, "LINE_OFFICIAL_ACCOUNT_UNAVAILABLE", "目前無法取得 LINE 官方帳號入口。");
  }
  if (!infoResponse.ok) throw new ApiError(503, "LINE_OFFICIAL_ACCOUNT_UNAVAILABLE", "目前無法取得 LINE 官方帳號入口。");

  const info = await infoResponse.json().catch(() => ({})) as Json;
  const basicId = asText(info.basicId, 80);
  if (!/^@[A-Za-z0-9._-]{2,79}$/.test(basicId)) {
    throw new ApiError(503, "LINE_OFFICIAL_ACCOUNT_UNAVAILABLE", "LINE 官方帳號識別尚未設定完成。");
  }
  return {
    basicId,
    chatUrl: "https://line.me/R/oaMessage/" + encodeURIComponent(basicId),
  };
}

async function referralBind(supabase: SupabaseClient, identity: Identity, body: Json, member: any): Promise<Json> {
  let inviteCode = asText(body.inviteCode, 20);
  if (body.memberCode) {
    const memberCode = asText(body.memberCode, 41).toUpperCase();
    if (!/^[A-Z0-9_-]{4,40}$/.test(memberCode)) throw new ApiError(400, "INVALID_INVITE_CODE", "請輸入有效的會員編號。");
    const inviter = await supabase.from("members").select("invite_code")
      .eq("member_code", memberCode).eq("status", "active").eq("membership_status", "active")
      .eq("is_test_account", member.is_test_account).maybeSingle();
    if (inviter.error) throw new ApiError(500, "DATABASE_ERROR", "邀請資料暫時無法讀取。");
    if (!inviter.data?.invite_code) throw new ApiError(404, "INVITE_CODE_NOT_FOUND", "找不到此會員的邀請資料。");
    inviteCode = inviter.data.invite_code;
  }
  const result = await supabase.rpc("bind_member_referral", {
    p_invitee_line_user_id: identity.lineUserId,
    p_invite_code: inviteCode,
    p_request_id: asText(body.requestId, 120),
  });
  if (result.error) throw mapDatabaseError(result.error);
  return (result.data || {}) as Json;
}
async function transferOptions(supabase: SupabaseClient, member: any): Promise<Json> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
  const result = await supabase
    .from("point_balances")
    .select("stamps,point_cards!inner(card_id,title,status,expiry_mode,expires_on)")
    .eq("member_id", member.id)
    .gt("stamps", 0);
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "集點資料暫時無法讀取。");
  const cards = (result.data || []).map((row: any) => {
    const card = row.point_cards || {};
    const active = card.status === "active" && (card.expiry_mode === "unlimited" || (card.expires_on && card.expires_on >= today));
    return active ? {
      cardId: String(card.card_id || ""),
      title: String(card.title || "集點卡"),
      balance: Math.max(0, Number(row.stamps || 0)),
      expiresOn: card.expiry_mode === "date" ? card.expires_on : null,
    } : null;
  }).filter(Boolean);
  return { cards };
}
async function transferReceiver(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const result = await supabase.rpc("lookup_point_transfer_receiver", {
    p_sender_line_user_id: identity.lineUserId,
    p_receiver_member_code: asText(body.memberCode, 40),
  });
  if (result.error) throw mapDatabaseError(result.error);
  const value = result.data && typeof result.data === "object" ? result.data as Json : {};
  return {
    memberCode: asText(value.memberCode, 40),
    displayName: maskName(value.displayName),
  };
}
async function transferCreate(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError(400, "INVALID_TRANSFER_AMOUNT", "轉贈點數必須是大於 0 的整數。");
  const result = await supabase.rpc("transfer_member_points", {
    p_sender_line_user_id: identity.lineUserId,
    p_receiver_member_code: asText(body.memberCode, 40),
    p_card_id: asText(body.cardId, 80),
    p_amount: amount,
    p_request_id: asText(body.requestId, 120),
  });
  if (result.error) throw mapDatabaseError(result.error);
  return (result.data || {}) as Json;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return response(origin, { ok:false, error:{ code:"METHOD_NOT_ALLOWED", message:"只支援 POST。" } }, 405);
  if (origin && !allowedOrigins().has(origin)) return response(origin, { ok:false, error:{ code:"ORIGIN_DENIED", message:"不允許的來源。" } }, 403);

  try {
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);
    const clientType = asText(body.clientType, 20) as ClientType;
    const action = asText(body.action, 100);
    const allowed: Record<ClientType, Set<string>> = {
      member: new Set(["member.referral.bind","member.line.official-account","member.friend.list","member.friend.lookup","member.friend.request","member.friend.accept","member.friend.remove","member.friend.block"]),
      booking:new Set(["member.friend.list"]),
      event: new Set(["event.today-usable"]),
      points: new Set(["points.transfer.options","points.transfer.receiver","points.transfer.create","member.friend.list"]),
    };
    if (!["member","event","points","booking"].includes(clientType) || !allowed[clientType]?.has(action)) {
      throw new ApiError(403, "CLIENT_ACTION_MISMATCH", "操作端與功能不相符。");
    }

    const supabase = dbClient();
    const identity = await resolveIdentity(supabase, body, clientType);
    const write = action === "member.friend.lookup" || action === "member.referral.bind" || action === "points.transfer.create" || /^member\.friend\.(request|accept|remove|block)$/.test(action);
    await consumeRateLimit(supabase, identity, write);
    const member = await requireMember(supabase, identity);

    let data: Json;
    if (action.startsWith("member.friend.")) {
      const operation=action.split('.').pop();
      const r=await supabase.rpc("member_friend_action",{p_actor:identity.lineUserId,p_operation:operation,p_code:asText(body.memberCode || body.inviteCode,40)});
      if(r.error) throw mapDatabaseError(r.error);
      data=r.data as Json;
    }
    else if (action === "event.today-usable") data = await todayUsable(supabase, identity);
    else if (action === "member.referral.bind") data = await referralBind(supabase, identity, body, member);
    else if (action === "member.line.official-account") data = await lineOfficialAccount(supabase);
    else if (action === "points.transfer.options") data = await transferOptions(supabase, member);
    else if (action === "points.transfer.receiver") data = await transferReceiver(supabase, identity, body);
    else data = await transferCreate(supabase, identity, body);

    return response(origin, { ok:true, status:200, data });
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "會員服務暫時無法完成操作。");
    return response(origin, { ok:false, status:e.status, error:{ code:e.code, message:e.message, details:e.details } }, e.status);
  }
});
