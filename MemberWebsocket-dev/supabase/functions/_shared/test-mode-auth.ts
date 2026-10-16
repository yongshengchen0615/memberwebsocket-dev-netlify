export type TestModeIdentity = {
  lineUserId: string;
  displayName: string;
  memberId: string;
  isTestAccount: true;
  surface: string;
};

export type TestDeviceClass = "pc" | "mobile";

const SESSION_TOUCH_INTERVAL_MS = 60_000;

function maintenanceMessage(settings: any): string {
  return String(settings?.maintenance_message || "").trim() || "系統維護中，請稍後再試。";
}

function deviceLoginAllowed(settings: any, deviceClass: TestDeviceClass): boolean {
  return deviceClass === "mobile"
    ? settings?.allow_mobile_test_login === true
    : settings?.allow_pc_test_login === true;
}

export class TestModeAuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolveTestSession(
  supabase: any,
  rawToken: string,
  prefetchedSettings: any = null,
): Promise<TestModeIdentity> {
  const token = String(rawToken || "").trim();
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    throw new TestModeAuthError(401, "TEST_SESSION_INVALID", "測試登入已失效，請重新選擇測試帳號。");
  }

  const tokenHash = await sha256Hex(token);
  const settingsPromise = prefetchedSettings
    ? Promise.resolve({ data: prefetchedSettings, error: null })
    : supabase
      .from("test_mode_settings")
      .select("maintenance_enabled,allow_pc_test_login,allow_mobile_test_login,maintenance_message")
      .eq("id", true)
      .maybeSingle();
  const [settingsResult, sessionResult] = await Promise.all([
    settingsPromise,
    supabase
      .from("test_login_sessions")
      .select("id,member_id,device_class,surface,expires_at,revoked_at,revoked_reason,last_used_at")
      .eq("token_hash", tokenHash)
      .maybeSingle(),
  ]);

  if (settingsResult.error || sessionResult.error) {
    throw new TestModeAuthError(503, "TEST_SESSION_UNAVAILABLE", "目前無法確認測試登入狀態。");
  }

  if (!settingsResult.data?.maintenance_enabled) {
    throw new TestModeAuthError(403, "TEST_LOGIN_DISABLED", "目前未啟用系統維護測試登入。");
  }

  const session = sessionResult.data;
  const deviceClass = session?.device_class === "mobile"
    ? "mobile"
    : session?.device_class === "pc"
      ? "pc"
      : null;
  if (!deviceClass) {
    throw new TestModeAuthError(401, "TEST_SESSION_INVALID", "測試登入已失效，請重新選擇測試帳號。");
  }
  if (!deviceLoginAllowed(settingsResult.data, deviceClass)) {
    throw new TestModeAuthError(503, "SYSTEM_MAINTENANCE", maintenanceMessage(settingsResult.data));
  }
  const expiresAt = session?.expires_at ? new Date(session.expires_at).getTime() : 0;
  if (!session) {
    throw new TestModeAuthError(401, "TEST_SESSION_INVALID", "測試登入已失效，請重新選擇測試帳號。");
  }
  if (session.revoked_at) {
    if (session.revoked_reason === "replaced_by_new_login") {
      throw new TestModeAuthError(401, "SESSION_REPLACED", "此測試帳號已在其他視窗或裝置成功登入，原連線已被強制登出。");
    }
    throw new TestModeAuthError(401, "SESSION_REVOKED", "您的測試登入工作階段已被管理員結束。");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new TestModeAuthError(401, "TEST_SESSION_EXPIRED", "測試登入已過期，請重新選擇測試帳號。");
  }

  const memberResult = await supabase
    .from("members")
    .select("id,line_user_id,display_name,status,membership_status,is_test_account")
    .eq("id", session.member_id)
    .maybeSingle();

  if (memberResult.error) {
    throw new TestModeAuthError(503, "TEST_SESSION_UNAVAILABLE", "目前無法確認測試登入狀態。");
  }

  const member = memberResult.data;
  if (
    !member
    || member.is_test_account !== true
    || member.status !== "active"
    || member.membership_status !== "active"
  ) {
    throw new TestModeAuthError(403, "TEST_ACCOUNT_UNAVAILABLE", "選擇的測試帳號目前無法使用。");
  }

  const now = Date.now();
  const lastUsedAt = session.last_used_at ? new Date(session.last_used_at).getTime() : 0;
  if (!Number.isFinite(lastUsedAt) || now - lastUsedAt >= SESSION_TOUCH_INTERVAL_MS) {
    const staleBefore = new Date(now - SESSION_TOUCH_INTERVAL_MS).toISOString();
    const touch = await supabase
      .from("test_login_sessions")
      .update({ last_used_at: new Date(now).toISOString() })
      .eq("id", session.id)
      .is("revoked_at", null)
      .lt("last_used_at", staleBefore);
    if (touch.error) {
      throw new TestModeAuthError(503, "TEST_SESSION_UNAVAILABLE", "目前無法更新測試登入狀態。");
    }
  }

  return {
    lineUserId: String(member.line_user_id),
    displayName: String(member.display_name || "測試會員"),
    memberId: String(member.id),
    isTestAccount: true,
    surface: String(session.surface || ""),
  };
}

export async function resolveUserTestIdentity(
  supabase: any,
  rawToken: string,
): Promise<TestModeIdentity | null> {
  const settingsResult = await supabase
    .from("test_mode_settings")
    .select("maintenance_enabled,allow_pc_test_login,allow_mobile_test_login,maintenance_message")
    .eq("id", true)
    .maybeSingle();

  if (settingsResult.error) {
    throw new TestModeAuthError(503, "TEST_MODE_CHECK_FAILED", "目前無法確認系統維護狀態。");
  }

  if (!settingsResult.data?.maintenance_enabled) return null;

  const token = String(rawToken || "").trim();
  if (!token) {
    throw new TestModeAuthError(503, "SYSTEM_MAINTENANCE", maintenanceMessage(settingsResult.data));
  }

  return await resolveTestSession(supabase, token, settingsResult.data);
}
