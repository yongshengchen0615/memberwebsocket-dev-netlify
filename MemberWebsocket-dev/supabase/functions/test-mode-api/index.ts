import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { resolveTestSession, TestModeAuthError } from "../_shared/test-mode-auth.ts";

type Json = Record<string, unknown>;
type Surface = "member" | "points" | "event" | "calendar" | "booking" | "admin";
type Identity = { lineUserId: string; displayName: string };

const MAX_REQUEST_BYTES = 20_000;
const TEST_SESSION_HOURS = 2;
const USER_SURFACES = new Set<Surface>(["member", "points", "event", "calendar", "booking"]);

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

function errorReply(origin: string | null, error: unknown): Response {
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof TestModeAuthError) {
    apiError = new ApiError(error.status, error.code, error.message);
  } else {
    const message = String((error as { message?: string })?.message || "");
    if (message.includes("INVALID_TEST_ACCOUNT_COUNT")) {
      apiError = new ApiError(400, "INVALID_TEST_ACCOUNT_COUNT", "每次新增測試帳號數量必須為 0–50。");
    } else if (message.includes("INVALID_MAINTENANCE_MESSAGE")) {
      apiError = new ApiError(400, "INVALID_MAINTENANCE_MESSAGE", "系統維護訊息不可超過 500 字。");
    } else if (message.includes("TEST_ACCOUNT_LIMIT_REACHED")) {
      apiError = new ApiError(409, "TEST_ACCOUNT_LIMIT_REACHED", "測試帳號總數已達 200 個上限。");
    } else if (message.includes("INVALID_TEST_ACCOUNT_DELETE_COUNT")) {
      apiError = new ApiError(400, "INVALID_TEST_ACCOUNT_DELETE_COUNT", "每次移除測試帳號必須選擇 1–200 個。");
    } else if (message.includes("DUPLICATE_TEST_ACCOUNT_ID")) {
      apiError = new ApiError(400, "DUPLICATE_TEST_ACCOUNT_ID", "批次移除清單包含重複的測試帳號。");
    } else if (message.includes("INVALID_TEST_ACCOUNT_SELECTION")) {
      apiError = new ApiError(409, "INVALID_TEST_ACCOUNT_SELECTION", "只能移除目前仍存在的測試帳號，請重新整理後再試。");
    } else if (message.includes("TEST_ACCOUNT_DELETE_MISMATCH")) {
      apiError = new ApiError(409, "TEST_ACCOUNT_DELETE_MISMATCH", "測試帳號資料已變更，請重新整理後再試。");
    } else if (message.includes("TEST_LOGIN_DISABLED")) {
      apiError = new ApiError(403, "TEST_LOGIN_DISABLED", "此裝置目前不能使用測試登入。");
    } else if (message.includes("TEST_ACCOUNT_UNAVAILABLE")) {
      apiError = new ApiError(403, "TEST_ACCOUNT_UNAVAILABLE", "選擇的測試帳號目前無法使用。");
    } else if (message.includes("TEST_SURFACE_ALREADY_ACTIVE")) {
      apiError = new ApiError(409, "TEST_SURFACE_ALREADY_ACTIVE", "此測試帳號已在相同用戶端登入，請改用其他測試帳號或先關閉原本視窗。");
    } else {
      apiError = new ApiError(500, "TEST_MODE_ERROR", "測試模式服務暫時無法完成操作。");
    }
  }
  return reply(origin, {
    ok: false,
    status: apiError.status,
    error: { code: apiError.code, message: apiError.message, details: apiError.details },
  }, apiError.status);
}

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new ApiError(400, "INVALID_NUMBER", "數量必須是整數。");
  return number;
}

function dbClient() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function channelIdFor(surface: Surface): string {
  const envNames: Record<Surface, string> = {
    member: "LINE_MEMBER_CHANNEL_ID",
    points: "LINE_POINTS_CHANNEL_ID",
    event: "LINE_EVENT_CHANNEL_ID",
    calendar: "LINE_CALENDAR_CHANNEL_ID",
    booking: "LINE_MEMBER_CHANNEL_ID",
    admin: "LINE_ADMIN_CHANNEL_ID",
  };
  const fallback = surface === "admin" ? "2010791619" : "2010787602";
  const value = env(envNames[surface]) || fallback;
  if (!/^\d{5,30}$/.test(value)) {
    throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 驗證設定尚未完成。");
  }
  return value;
}

async function verifyLineIdToken(idToken: string, surface: Surface): Promise<Identity> {
  return await verifyLineIdTokenContract({
    idToken: asText(idToken, 10_000),
    expectedChannelId: channelIdFor(surface),
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  }) as Identity;
}

async function authorizeAdmin(supabase: any, identity: Identity): Promise<any> {
  return await requireActiveAdminContract({
    supabase,
    identity,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function settings(supabase: any): Promise<any> {
  const result = await supabase.from("test_mode_settings")
    .select("maintenance_enabled,allow_pc_test_login,allow_mobile_test_login,allow_duplicate_test_login,maintenance_message,updated_by,updated_at")
    .eq("id", true)
    .maybeSingle();
  if (result.error) throw new ApiError(503, "TEST_MODE_SETTINGS_UNAVAILABLE", "目前無法讀取系統維護設定。");
  return result.data || {
    maintenance_enabled: false,
    allow_pc_test_login: false,
    allow_mobile_test_login: false,
    allow_duplicate_test_login: false,
    maintenance_message: "",
    updated_by: null,
    updated_at: null,
  };
}

function settingsClient(row: any): Json {
  return {
    maintenanceEnabled: Boolean(row?.maintenance_enabled),
    allowPcTestLogin: Boolean(row?.allow_pc_test_login),
    allowMobileTestLogin: Boolean(row?.allow_mobile_test_login),
    allowDuplicateTestLogin: Boolean(row?.allow_duplicate_test_login),
    maintenanceMessage: asText(row?.maintenance_message, 500),
    updatedBy: asText(row?.updated_by, 120),
    updatedAt: row?.updated_at || null,
  };
}

async function ensureMembershipJoinTicketForTestAccount(supabase: any, memberId: string): Promise<Json> {
  const result = await supabase.rpc("issue_membership_join_ticket", {
    p_member_id: memberId,
  });
  if (result.error) {
    throw new ApiError(
      503,
      "TEST_MEMBERSHIP_JOIN_TICKET_SYNC_FAILED",
      "目前無法同步測試帳號的加入會員票券。",
    );
  }
  return result.data && typeof result.data === "object" ? result.data as Json : {};
}

async function testAccounts(supabase: any): Promise<any[]> {
  const result = await supabase.from("members")
    .select("id,display_name,member_code,status,membership_status,test_account_sequence,created_at")
    .eq("is_test_account", true)
    .order("test_account_sequence", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (result.error) throw new ApiError(503, "TEST_ACCOUNT_LIST_FAILED", "目前無法讀取測試帳號。");
  return (result.data || []).map((row: any) => ({
    memberId: row.id,
    displayName: row.display_name || "測試會員",
    memberCode: row.member_code,
    status: row.status,
    membershipStatus: row.membership_status,
    sequence: row.test_account_sequence,
    createdAt: row.created_at,
  }));
}


async function activeSurfaceMap(supabase: any, memberIds: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (!memberIds.length) return map;

  const staleCutoff = new Date(Date.now() - 90_000).toISOString();
  const recentSessionCutoff = new Date(Date.now() - 15_000).toISOString();
  const [presenceResult, sessionResult] = await Promise.all([
    supabase.from("member_presence_sessions")
      .select("member_id,surface,last_seen_at,offline_at")
      .in("member_id", memberIds)
      .is("offline_at", null)
      .gte("last_seen_at", staleCutoff),
    supabase.from("test_login_sessions")
      .select("member_id,surface,created_at,expires_at,revoked_at")
      .in("member_id", memberIds)
      .is("revoked_at", null)
      .gte("created_at", recentSessionCutoff)
      .gt("expires_at", new Date().toISOString()),
  ]);
  if (presenceResult.error || sessionResult.error) {
    throw new ApiError(503, "TEST_ACCOUNT_PRESENCE_FAILED", "目前無法確認測試帳號登入狀態。");
  }
  for (const row of [...(presenceResult.data || []), ...(sessionResult.data || [])]) {
    const memberId = asText(row.member_id, 80);
    const surface = asText(row.surface, 20);
    if (!memberId || !USER_SURFACES.has(surface as Surface)) continue;
    const set = map.get(memberId) || new Set<string>();
    set.add(surface);
    map.set(memberId, set);
  }
  return map;
}

function accountsWithAvailability(accounts: any[], surfaceMap: Map<string, Set<string>>, clientType: Surface): any[] {
  return accounts.map((account) => {
    const activeSurfaces = Array.from(surfaceMap.get(String(account.memberId)) || []).sort();
    return {
      ...account,
      activeSurfaces,
      currentSurfaceInUse: activeSurfaces.includes(clientType),
    };
  });
}

async function emitTestModeEvent(supabase: any, eventType: string): Promise<void> {
  const result = await supabase.from("realtime_events").insert({
    scope: "all",
    event_type: asText(eventType, 120),
  });
  if (result.error) {
    throw new ApiError(503, "TEST_MODE_REALTIME_FAILED", "測試模式已更新，但即時同步事件建立失敗。");
  }
}

async function audit(
  supabase: any,
  identity: Identity,
  action: string,
  targetType: string,
  targetId: string,
  detail: Json = {},
): Promise<void> {
  await supabase.from("audit_logs").insert({
    audit_id: "TST-" + crypto.randomUUID(),
    actor_line_user_id: identity.lineUserId,
    actor_role: "admin",
    action,
    target_type: targetType,
    target_id: targetId,
    result: "success",
    detail,
  });
}

async function auditTestAccount(
  supabase: any,
  member: any,
  action: string,
  targetType: string,
  targetId: string,
  detail: Json = {},
): Promise<void> {
  await supabase.from("audit_logs").insert({
    audit_id: "TST-" + crypto.randomUUID(),
    actor_line_user_id: asText(member?.line_user_id, 120) || null,
    actor_role: "test_account",
    action,
    target_type: targetType,
    target_id: targetId,
    result: "success",
    detail,
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function maintenanceMessage(row: any): string {
  return asText(row?.maintenance_message, 500) || "系統維護中，請稍後再試。";
}

function deviceClassForRequest(request: Request): "pc" | "mobile" {
  const mobileHint = String(request.headers.get("sec-ch-ua-mobile") || "").trim();
  if (mobileHint === "?1") return "mobile";
  if (mobileHint === "?0") return "pc";
  return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(
    String(request.headers.get("user-agent") || ""),
  ) ? "mobile" : "pc";
}

async function requireTestLoginEnabled(supabase: any, request: Request): Promise<{ row: any; deviceClass: "pc" | "mobile" }> {
  const row = await settings(supabase);
  if (!row.maintenance_enabled) {
    throw new ApiError(403, "TEST_LOGIN_REQUIRES_MAINTENANCE", "測試帳號登入只在系統維護期間開放。");
  }
  const deviceClass = deviceClassForRequest(request);
  const allowed = deviceClass === "mobile"
    ? row.allow_mobile_test_login === true
    : row.allow_pc_test_login === true;
  if (!allowed) {
    throw new ApiError(503, "SYSTEM_MAINTENANCE", maintenanceMessage(row));
  }
  return { row, deviceClass };
}

async function readBody(request: Request): Promise<Json> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "請求內容過大。");
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Json;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "請求內容必須是有效 JSON。");
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return errorReply(origin, new ApiError(405, "METHOD_NOT_ALLOWED", "只支援 POST。"));
  if (origin && !allowedOrigins().has(origin)) {
    return errorReply(origin, new ApiError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未被允許使用測試模式服務。"));
  }

  try {
    const body = await readBody(request);
    const action = asText(body.action, 80);
    const clientType = asText(body.clientType, 20) as Surface;
    const supabase = dbClient();

    if (action === "public.status") {
      const row = await settings(supabase);
      return reply(origin, {
        ok: true, status: 200, data: {
          maintenanceEnabled: Boolean(row.maintenance_enabled),
          allowPcTestLogin: Boolean(row.allow_pc_test_login),
          allowMobileTestLogin: Boolean(row.allow_mobile_test_login),
          maintenanceMessage: asText(row.maintenance_message, 500),
        },
      });
    }

    if (action === "session.status") {
      const identity = await resolveTestSession(supabase, asText(body.testSessionToken, 200));
      if (USER_SURFACES.has(clientType) && identity.surface && identity.surface !== clientType) {
        throw new ApiError(409, "TEST_SESSION_SURFACE_MISMATCH", "此測試登入屬於其他用戶端，請重新選擇測試帳號。");
      }
      await ensureMembershipJoinTicketForTestAccount(supabase, identity.memberId);
      const memberResult = await supabase.from("members")
        .select("id,display_name,member_code")
        .eq("id", identity.memberId)
        .single();
      if (memberResult.error) throw new ApiError(404, "TEST_ACCOUNT_NOT_FOUND", "找不到測試帳號。");
      return reply(origin, {
        ok: true, status: 200, data: {
          active: true,
          account: {
            memberId: memberResult.data.id,
            displayName: memberResult.data.display_name,
            memberCode: memberResult.data.member_code,
          },
          surface: identity.surface,
        },
      });
    }

    if (!["member", "points", "event", "calendar", "booking", "admin"].includes(clientType)) {
      throw new ApiError(400, "INVALID_CLIENT_TYPE", "不支援的操作端。");
    }

    if (action === "test-mode.accounts") {
      if (!USER_SURFACES.has(clientType)) throw new ApiError(403, "USER_SURFACE_REQUIRED", "請從用戶端進行測試登入。");
      const { row } = await requireTestLoginEnabled(supabase, request);
      const accounts = (await testAccounts(supabase)).filter((account) =>
        account.status === "active" && account.membershipStatus === "active"
      );
      const surfaceMap = await activeSurfaceMap(supabase, accounts.map((account) => String(account.memberId)));
      return reply(origin, { ok: true, status: 200, data: {
        accounts: accountsWithAvailability(accounts, surfaceMap, clientType),
        allowDuplicateTestLogin: row.allow_duplicate_test_login === true,
      } });
    }

    if (action === "test-mode.login") {
      if (!USER_SURFACES.has(clientType)) throw new ApiError(403, "USER_SURFACE_REQUIRED", "請從用戶端進行測試登入。");
      const { deviceClass } = await requireTestLoginEnabled(supabase, request);
      const memberId = asText(body.memberId, 80);
      if (!/^[0-9a-f-]{36}$/i.test(memberId)) throw new ApiError(400, "INVALID_TEST_ACCOUNT", "測試帳號識別不正確。");

      const memberResult = await supabase.from("members")
        .select("id,line_user_id,display_name,member_code,status,membership_status,is_test_account")
        .eq("id", memberId)
        .maybeSingle();
      if (memberResult.error) throw new ApiError(503, "TEST_ACCOUNT_LOOKUP_FAILED", "目前無法確認測試帳號。");
      const member = memberResult.data;
      if (!member || member.is_test_account !== true || member.status !== "active" || member.membership_status !== "active") {
        throw new ApiError(403, "TEST_ACCOUNT_UNAVAILABLE", "選擇的測試帳號目前無法使用。");
      }

      // Test accounts are reusable fixtures and may predate the current membership-join
      // ticket configuration. Re-run the idempotent issuer on login so an active
      // test account can exercise the same server-issued benefit as a newly joined member.
      await ensureMembershipJoinTicketForTestAccount(supabase, member.id);

      const token = randomToken();
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + TEST_SESSION_HOURS * 60 * 60 * 1000).toISOString();

      const sessionResult = await supabase.rpc("create_test_login_session_v3", {
        p_token_hash: tokenHash,
        p_member_id: member.id,
        p_surface: clientType,
        p_device_class: deviceClass,
        p_expires_at: expiresAt,
      });
      if (sessionResult.error) {
        const message = String(sessionResult.error.message || "");
        if (message.includes("TEST_SURFACE_ALREADY_ACTIVE")) {
          throw new ApiError(409, "TEST_SURFACE_ALREADY_ACTIVE", "此測試帳號已在相同用戶端登入，請改用其他測試帳號或先關閉原本視窗。");
        }
        throw new ApiError(503, "TEST_SESSION_CREATE_FAILED", "目前無法建立測試登入。");
      }
      // Session creation RPC commits the takeover and realtime notification atomically.

      await auditTestAccount(supabase, member, "test_mode.session.start", "member", member.id, {
        memberCode: member.member_code,
        expiresAt,
        clientType,
        deviceClass,
      });

      return reply(origin, {
        ok: true, status: 200, data: {
          testSessionToken: token,
          expiresAt,
          account: {
            memberId: member.id,
            displayName: member.display_name,
            memberCode: member.member_code,
          },
          surface: clientType,
        },
      });
    }

    const identity = await verifyLineIdToken(asText(body.idToken, 10_000), clientType);
    await authorizeAdmin(supabase, identity);

    if (action === "admin.test-mode.bootstrap") {
      if (clientType !== "admin") throw new ApiError(403, "ADMIN_SURFACE_REQUIRED", "請從管理端操作系統維護設定。");
      const [row, accounts] = await Promise.all([settings(supabase), testAccounts(supabase)]);
      const surfaceMap = await activeSurfaceMap(supabase, accounts.map((account) => String(account.memberId)));
      const enriched = accounts.map((account) => ({
        ...account,
        activeSurfaces: Array.from(surfaceMap.get(String(account.memberId)) || []).sort(),
      }));
      return reply(origin, { ok: true, status: 200, data: { settings: settingsClient(row), accounts: enriched } });
    }

    if (action === "admin.test-mode.delete-accounts") {
      if (clientType !== "admin") throw new ApiError(403, "ADMIN_SURFACE_REQUIRED", "請從管理端移除測試帳號。");
      const rawMemberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
      if (rawMemberIds.length < 1 || rawMemberIds.length > 200) {
        throw new ApiError(400, "INVALID_TEST_ACCOUNT_DELETE_COUNT", "每次移除測試帳號必須選擇 1–200 個。");
      }
      const memberIds = rawMemberIds.map((value) => asText(value, 80));
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (memberIds.some((memberId) => !uuidPattern.test(memberId))) {
        throw new ApiError(400, "INVALID_TEST_ACCOUNT_SELECTION", "測試帳號識別不正確，請重新整理後再試。");
      }
      if (new Set(memberIds).size !== memberIds.length) {
        throw new ApiError(400, "DUPLICATE_TEST_ACCOUNT_ID", "批次移除清單包含重複的測試帳號。");
      }

      const rpc = await supabase.rpc("admin_delete_test_accounts", {
        p_member_ids: memberIds,
      });
      if (rpc.error) throw rpc.error;

      const deletedAccountCount = Number(rpc.data?.[0]?.deleted_account_count || 0);
      if (deletedAccountCount !== memberIds.length) {
        throw new ApiError(409, "TEST_ACCOUNT_DELETE_MISMATCH", "測試帳號資料已變更，請重新整理後再試。");
      }

      await audit(
        supabase,
        identity,
        memberIds.length === 1 ? "test_mode.account.delete" : "test_mode.accounts.batch_delete",
        "test_account_purge",
        "purged",
        { deletedAccountCount, batch: memberIds.length > 1 },
      );

      await emitTestModeEvent(supabase, "test_mode.account.deleted");
      const [row, accounts] = await Promise.all([settings(supabase), testAccounts(supabase)]);
      return reply(origin, {
        ok: true,
        status: 200,
        data: {
          settings: settingsClient(row),
          accounts,
          deletedAccountCount,
        },
      });
    }

    if (action === "admin.test-mode.save") {
      if (clientType !== "admin") throw new ApiError(403, "ADMIN_SURFACE_REQUIRED", "請從管理端操作系統維護設定。");
      const addAccountCount = asInteger(body.addAccountCount ?? 0);
      const maintenanceMessage = asText(body.maintenanceMessage, 501);
      if (maintenanceMessage.length > 500) {
        throw new ApiError(400, "INVALID_MAINTENANCE_MESSAGE", "系統維護訊息不可超過 500 字。");
      }
      const rpc = await supabase.rpc("admin_save_maintenance_test_access_v2", {
        p_maintenance_enabled: asBoolean(body.maintenanceEnabled),
        p_allow_pc_test_login: asBoolean(body.allowPcTestLogin),
        p_allow_mobile_test_login: asBoolean(body.allowMobileTestLogin),
        p_allow_duplicate_test_login: asBoolean(body.allowDuplicateTestLogin),
        p_maintenance_message: maintenanceMessage,
        p_updated_by: identity.lineUserId,
        p_add_account_count: addAccountCount,
      });
      if (rpc.error) throw rpc.error;
      await audit(supabase, identity, "maintenance_test_access.settings.update", "maintenance", "singleton", {
        maintenanceEnabled: asBoolean(body.maintenanceEnabled),
        allowPcTestLogin: asBoolean(body.allowPcTestLogin),
        allowMobileTestLogin: asBoolean(body.allowMobileTestLogin),
        allowDuplicateTestLogin: asBoolean(body.allowDuplicateTestLogin),
        addAccountCount,
      });
      await emitTestModeEvent(supabase, "test_mode.settings.changed");
      const [row, accounts] = await Promise.all([settings(supabase), testAccounts(supabase)]);
      return reply(origin, {
        ok: true, status: 200, data: {
          settings: settingsClient(row),
          accounts,
          createdAccountCount: Number(rpc.data?.[0]?.created_account_count || addAccountCount || 0),
        },
      });
    }

    throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的測試模式操作。");
  } catch (error) {
    return errorReply(origin, error);
  }
});
