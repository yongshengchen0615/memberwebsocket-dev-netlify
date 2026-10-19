import { businessEnv, businessContext, businessFetch as fetch } from './business-scope.ts';
import { assertTenantIdentity } from './tenant-access.mjs';
export type ContractIdentity = { lineUserId: string; displayName: string; issuedAtMs: number };

type ErrorFactory = (status: number, code: string, message: string, details?: unknown) => Error;

export async function verifyLineIdTokenContract(args: {
  idToken: string;
  expectedChannelId: string;
  createError: ErrorFactory;
  allowLoginClaim?: boolean;
}): Promise<ContractIdentity> {
  const { idToken, expectedChannelId, createError, allowLoginClaim = false } = args;
  if (!idToken) throw createError(401, "AUTH_REQUIRED", "請先使用 LINE 登入。");

  let response: Response;
  try {
    response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: expectedChannelId }),
    });
  } catch {
    throw createError(503, "LINE_AUTH_UNAVAILABLE", "LINE 身分驗證服務暫時無法使用。");
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json();
  } catch {
    throw createError(503, "LINE_AUTH_UNAVAILABLE", "LINE 身分驗證服務暫時無法使用。");
  }

  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const aud = typeof payload.aud === "string" ? payload.aud.trim() : "";
  const iss = typeof payload.iss === "string" ? payload.iss.trim() : "";
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  if (!response.ok || !sub || aud !== expectedChannelId || iss !== "https://access.line.me" || !Number.isFinite(exp) || exp * 1000 <= Date.now() || !Number.isFinite(iat) || iat <= 0) {
    throw createError(401, "AUTH_INVALID", "LINE 登入已失效，請重新登入。");
  }

  const identity = {
    lineUserId: sub,
    displayName: String(payload.name || "LINE 使用者").slice(0, 120),
    issuedAtMs: iat * 1000,
  };
  try { assertTenantIdentity(businessContext(), identity); }
  catch (error) { const e=error as {status:number;code:string;message:string}; throw createError(e.status,e.code,e.message); }

  const url = (businessEnv("SUPABASE_URL") || "").trim();
  const key = (businessEnv("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!url || !key) throw createError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");

  const { createClient } = await import('./business-runtime.ts');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [settingsResult, adminResult, memberResult, removalResult] = await Promise.all([
    supabase.from("test_mode_settings").select("maintenance_enabled,maintenance_message,maintenance_revoked_after").eq("id", true).maybeSingle(),
    supabase.from("admins").select("role,status").eq("line_user_id", sub).maybeSingle(),
    supabase.from("members").select("force_logout_after").eq("line_user_id", sub).maybeSingle(),
    (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return await supabase.from('member_removal_jobs').select('state,revoked_before').eq('identity_hash', hash).maybeSingle();
    })(),
  ]);
  if (settingsResult.error || adminResult.error || memberResult.error || removalResult.error) {
    throw createError(503, "ACCESS_CONTROL_UNAVAILABLE", "目前無法確認會員存取狀態。");
  }

  if (removalResult.data && (removalResult.data.state !== 'complete' || identity.issuedAtMs <= new Date(removalResult.data.revoked_before).getTime())) {
    throw createError(401, 'MEMBER_REMOVED', '此會員資料已移除，原登入連線已失效。');
  }

  const isActiveAdmin = adminResult.data?.role === "admin" && adminResult.data?.status === "active";
  const adminChannelId = (businessEnv("LINE_ADMIN_CHANNEL_ID") || "2010791619").trim();
  const canBypassUserRestrictions = isActiveAdmin && expectedChannelId === adminChannelId;
  if (!canBypassUserRestrictions && settingsResult.data?.maintenance_enabled === true) {
    throw createError(503, "SYSTEM_MAINTENANCE", String(settingsResult.data?.maintenance_message || "").trim() || "系統維護中，請稍後再試。");
  }

  const memberRevokedAtMs = memberResult.data?.force_logout_after ? new Date(memberResult.data.force_logout_after).getTime() : 0;
  const maintenanceRevokedAtMs = settingsResult.data?.maintenance_revoked_after ? new Date(settingsResult.data.maintenance_revoked_after).getTime() : 0;
  const revokedAtMs = Math.max(
    Number.isFinite(memberRevokedAtMs) ? memberRevokedAtMs : 0,
    Number.isFinite(maintenanceRevokedAtMs) ? maintenanceRevokedAtMs : 0,
  );
  if (!canBypassUserRestrictions && revokedAtMs > 0 && identity.issuedAtMs <= revokedAtMs) {
    throw createError(401, "SESSION_REVOKED", "您的登入工作階段已結束，請重新登入。");
  }

  // A verified LINE ID token identifies a person, not a revocable application
  // connection. Once a browser has claimed a session, ONLY its registered token
  // fingerprints may authorize requests. Older deployments' unclaimed sessions
  // remain compatible until the first successful claim for that LINE identity.
  // Admin authentication is scoped to the server-verified admin LINE channel
  // and an active admin row. Member single-login grants must not invalidate
  // separately authenticated management workspaces.
  if (!allowLoginClaim && !canBypassUserRestrictions) {
    const sessionResult = await supabase.from("member_login_sessions")
      .select("line_user_id").eq("line_user_id", sub).maybeSingle();
    if (sessionResult.error) {
      throw createError(503, "ACCESS_CONTROL_UNAVAILABLE", "目前無法確認登入連線狀態。");
    }
    if (sessionResult.data) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idToken));
      const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const grantResult = await supabase.from("member_login_token_grants")
        .select("token_hash").eq("line_user_id", sub).eq("token_hash", fingerprint).maybeSingle();
      if (grantResult.error) {
        throw createError(503, "ACCESS_CONTROL_UNAVAILABLE", "目前無法確認登入連線狀態。");
      }
      if (!grantResult.data) {
        throw createError(401, "SESSION_REPLACED", "此帳號已在其他裝置登入，您已被登出。");
      }
    }
  }

  return identity;
}

export async function requireActiveAdminContract(args: {
  supabase: any;
  identity: { lineUserId: string; displayName?: string };
  createError: ErrorFactory;
}): Promise<any> {
  const { supabase, identity, createError } = args;
  let result = await supabase.from("admins").select("*").eq("line_user_id", identity.lineUserId).maybeSingle();
  if (result.error) throw createError(500, "DATABASE_ERROR", "目前無法確認管理端權限。");
  let admin = result.data;

  if (!admin) {
    const inserted = await supabase.from("admins").insert({
      line_user_id: identity.lineUserId,
      display_name: identity.displayName,
      role: "none",
      status: "pending",
    }).select("*").single();

    if (inserted.error) {
      result = await supabase.from("admins").select("*").eq("line_user_id", identity.lineUserId).maybeSingle();
      if (result.error || !result.data) throw createError(500, "DATABASE_ERROR", "目前無法建立管理端授權紀錄。");
      admin = result.data;
    } else {
      admin = inserted.data;
    }
  }

  if (admin.role !== "admin" || admin.status !== "active") {
    // Client-visible authorization errors must not echo the LINE user id or other identity PII.
    throw createError(403, "ADMIN_PENDING", "管理端帳號尚未授權。");
  }

  if (identity.displayName && admin.display_name !== identity.displayName) {
    await supabase.from("admins").update({
      display_name: identity.displayName,
      updated_at: new Date().toISOString(),
    }).eq("id", admin.id);
    admin.display_name = identity.displayName;
  }
  return admin;
}
