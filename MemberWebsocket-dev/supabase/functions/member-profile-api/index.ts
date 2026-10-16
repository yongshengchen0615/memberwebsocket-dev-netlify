import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract } from "../_shared/auth-contract.ts";
import { resolveUserTestIdentity, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

type Json = Record<string, unknown>;
type Identity = { lineUserId: string; displayName: string };

const MAX_REQUEST_BYTES = 20_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;

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
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io").split(",").map(v => v.trim()).filter(Boolean));
}
function corsHeaders(origin: string | null): HeadersInit {
  const resolved = origin && allowedOrigins().has(origin) ? origin : "";
  return { "Access-Control-Allow-Origin": resolved, "Access-Control-Allow-Headers": "content-type, apikey", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Max-Age": "86400", "Cache-Control": "no-store", "Vary": "Origin" };
}
function response(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" } });
}
function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL"); const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function verifyLineIdToken(idToken: string): Promise<Identity> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: env("LINE_MEMBER_CHANNEL_ID") || "2010787602",
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  }) as Identity;
}

async function consumeRateLimit(supabase: SupabaseClient, identity: Identity, write: boolean): Promise<void> {
  const { data, error } = await supabase.rpc("consume_api_rate_limit", { p_principal_hash: await sha256(identity.lineUserId), p_is_write: write, p_cost: 1, p_read_limit: READ_LIMIT, p_write_limit: WRITE_LIMIT });
  if (error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。");
  if (!data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。");
}
async function ensureMember(supabase: SupabaseClient, identity: Identity): Promise<any> {
  let result = await supabase.from("members").select("*").eq("line_user_id", identity.lineUserId).maybeSingle();
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "會員資料暫時無法讀取。");
  let member = result.data;
  if (!member) {
    const inserted = await supabase.from("members").insert({ line_user_id: identity.lineUserId, display_name: identity.displayName, member_code: "M" + crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase(), last_login_at: new Date().toISOString() }).select("*").single();
    if (inserted.error) {
      result = await supabase.from("members").select("*").eq("line_user_id", identity.lineUserId).single();
      if (result.error) throw new ApiError(500, "DATABASE_ERROR", "會員資料暫時無法建立。");
      member = result.data;
    } else member = inserted.data;
  } else {
    const patch: Json = { last_login_at: new Date().toISOString() };
    if (identity.displayName && identity.displayName !== member.display_name) patch.display_name = identity.displayName;
    const updated = await supabase.from("members").update(patch).eq("id", member.id).select("*").single();
    if (!updated.error) member = updated.data;
  }
  return member;
}
async function tierSettings(supabase: SupabaseClient): Promise<any[]> {
  const result = await supabase.from("membership_tier_settings").select("*").order("required_service_minutes", { ascending: true });
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "會員階級資料暫時無法讀取。");
  return result.data || [];
}
async function serviceMinutesTotal(supabase: SupabaseClient, memberId: string): Promise<number> {
  const result = await supabase.rpc("member_service_minute_totals", { p_member_ids: [memberId] });
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "會員服務時間暫時無法讀取。");
  return Number(result.data?.[0]?.total_minutes || 0);
}
async function profileFor(supabase: SupabaseClient, member: any): Promise<Json> {
  const [settings, total] = await Promise.all([tierSettings(supabase), serviceMinutesTotal(supabase, member.id)]);
  let current = settings[0] || { tier_key: "general", tier_label: "一般會員", required_service_minutes: 0, style_key: "forest" };
  for (const row of settings) if (Number(row.required_service_minutes || 0) <= total) current = row;
  const index = Math.max(0, settings.findIndex(row => row.tier_key === current.tier_key));
  const next = settings[index + 1] || null;
  const surname = asText(member.surname, 40);
  const salutation = asText(member.salutation, 10).toLowerCase();
  return {
    lineUserId: member.line_user_id,
    displayName: member.display_name || "LINE 使用者",
    memberCode: member.member_code,
    inviteCode: member.invite_code || "",
    status: member.status,
    joinedAt: member.joined_at || member.created_at,
    birthday: member.birthday || "",
    phone: normalizePhone(member.phone) || member.phone || "",
    surname,
    salutation,
    salutationLabel: salutation === "mr" ? "先生" : salutation === "ms" ? "小姐" : "",
    profileComplete: member.membership_status === "active" && Boolean(member.birthday && isValidPhone(normalizePhone(member.phone)) && surname && ["mr", "ms"].includes(salutation)),
    membershipRequired: member.membership_status !== "active",
    serviceMinutesTotal: total,
    tierKey: current.tier_key,
    tier: current.tier_label,
    tierStyleKey: current.style_key || "forest",
    tierProgress: {
      serviceMinutesTotal: total,
      currentRequiredServiceMinutes: Number(current.required_service_minutes || 0),
      nextTierKey: next?.tier_key || "",
      nextTierLabel: next?.tier_label || "",
      nextRequiredServiceMinutes: next ? Number(next.required_service_minutes || 0) : null,
      remainingServiceMinutes: next ? Math.max(0, Number(next.required_service_minutes || 0) - total) : 0,
      isHighestTier: !next,
    },
  };
}
async function termsForMember(supabase: SupabaseClient, member: any): Promise<{ terms: any; consentRequired: boolean }> {
  const scopes = member?.is_test_account === true ? ["e2e", "production"] : ["production"];
  let terms: any = null;
  for (const scope of scopes) {
    let query = supabase.from("membership_terms")
      .select("id,scope,e2e_member_id,version,title,summary,body,required,effective_at,reconsent_existing,activated_at")
      .eq("scope", scope)
      .eq("status", "active");
    if (scope === "e2e") query = query.eq("e2e_member_id", member.id);
    const result = await query.maybeSingle();
    if (result.error) throw new ApiError(503, "TERMS_UNAVAILABLE", "暫時無法讀取會員條款。");
    if (result.data && new Date(result.data.effective_at).getTime() <= Date.now()) {
      terms = result.data;
      break;
    }
  }
  if (member.membership_status !== "active") return { terms, consentRequired: true };
  if (!terms?.reconsent_existing || (member.is_test_account !== true && new Date(member.joined_at || member.created_at).getTime() >= new Date(terms.activated_at).getTime())) {
    return { terms, consentRequired: false };
  }
  const consent = await supabase.from("membership_consents").select("id").eq("member_id", member.id).eq("terms_id", terms.id).maybeSingle();
  if (consent.error) throw new ApiError(503, "TERMS_UNAVAILABLE", "暫時無法確認條款同意紀錄。");
  return { terms, consentRequired: !consent.data };
}
function normalizePhone(value: unknown): string {
  const compact = asText(value, 30).replace(/[()\s.\-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  if (/^0\d{8,9}$/.test(compact)) return `+886${compact.slice(1)}`;
  return compact;
}
function isValidE164(value: string): boolean { return /^\+[1-9]\d{7,14}$/.test(value); }
function hasSuspiciousPhoneRepetition(value: string): boolean { return /(\d)\1{6,}/.test(value.replace(/\D/g, "")); }
function isValidPhone(value: string): boolean {
  if (!isValidE164(value) || hasSuspiciousPhoneRepetition(value)) return false;
  if (value.startsWith("+886")) return /^\+886(?:9\d{8}|[2-8]\d{7,8})$/.test(value);
  return true;
}

async function requireCurrentSubmittedTerms(
  supabase: SupabaseClient,
  member: any,
  body: Json,
): Promise<{ terms: any; consentRequired: boolean }> {
  const snapshot = await termsForMember(supabase, member);
  if (!snapshot.terms) {
    throw new ApiError(503, "TERMS_UNAVAILABLE", "目前尚無有效會員條款，請聯繫管理員。");
  }
  const submittedId = asText(body.termsId, 100);
  const submittedVersion = asText(body.termsVersion, 200);
  if (
    submittedId !== String(snapshot.terms.id || "")
    || submittedVersion !== String(snapshot.terms.version || "")
  ) {
    throw new ApiError(
      409,
      "TERMS_VERSION_STALE",
      "會員條款已更新，請重新閱讀並確認。",
      { terms: snapshot.terms, consentRequired: snapshot.consentRequired },
    );
  }
  return snapshot;
}

async function throwTermsOperationError(
  supabase: SupabaseClient,
  member: any,
  error: { code?: string; message?: string; details?: string; hint?: string },
): Promise<never> {
  const mapped = termsError(error);
  if (mapped.code !== "TERMS_VERSION_STALE") throw mapped;
  try {
    const snapshot = await termsForMember(supabase, member);
    throw new ApiError(
      409,
      "TERMS_VERSION_STALE",
      "會員條款已更新，請重新閱讀並確認。",
      { terms: snapshot.terms, consentRequired: snapshot.consentRequired },
    );
  } catch (snapshotError) {
    if (snapshotError instanceof ApiError && snapshotError.code === "TERMS_VERSION_STALE") throw snapshotError;
    throw mapped;
  }
}

function termsError(error: { code?: string; message?: string; details?: string; hint?: string }): ApiError {
  const code = asText(error.code, 40).toUpperCase();
  const message = String(error.message || "");
  if (code === "PGRST202") {
    console.error("membership terms RPC schema cache miss", {
      code,
      message: message.slice(0, 500),
      hint: asText(error.hint, 300),
    });
    return new ApiError(503, "MEMBERSHIP_RPC_UNAVAILABLE", "會員服務正在同步，請重新送出一次。");
  }
  if (message.includes("TERMS_CONSENT_REQUIRED")) return new ApiError(400, "TERMS_CONSENT_REQUIRED", "請閱讀並勾選同意會員條款。");
  if (message.includes("TERMS_VERSION_STALE")) return new ApiError(409, "TERMS_VERSION_STALE", "會員條款已更新，請重新閱讀並確認。");
  if (message.includes("TERMS_UNAVAILABLE")) return new ApiError(503, "TERMS_UNAVAILABLE", "目前尚無有效會員條款，請聯繫管理員。");
  if (message.includes("INVALID_PROFILE")) return new ApiError(400, "INVALID_PROFILE", "會員資料不完整或格式不正確。");
  console.error("membership terms RPC failed", {
    code,
    message: message.slice(0, 500),
    hint: asText(error.hint, 300),
  });
  return new ApiError(500, "DATABASE_ERROR", "會員資料暫時無法儲存。");
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return response(origin, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支援 POST。" } }, 405);
  if (origin && !allowedOrigins().has(origin)) return response(origin, { ok: false, error: { code: "ORIGIN_DENIED", message: "不允許的來源。" } }, 403);
  try {
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);

    const action = asText(body.action, 80);
    if (!["user.member.bootstrap", "user.member.profile.save", "user.member.terms.accept", "user.member.card.open"].includes(action) || asText(body.clientType, 20) !== "member") throw new ApiError(403, "CLIENT_ACTION_MISMATCH", "操作端與功能不相符。");
    const supabase = dbClient();
    let identity: Identity;
    try {
      const testIdentity = await resolveUserTestIdentity(supabase, asText(body.testSessionToken, 200));
      identity = testIdentity
        ? { lineUserId: testIdentity.lineUserId, displayName: testIdentity.displayName }
        : await verifyLineIdToken(asText(body.idToken, 10_000));
    } catch (error) {
      if (error instanceof TestModeAuthError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
    await consumeRateLimit(supabase, identity, action !== "user.member.bootstrap");
    const member = await ensureMember(supabase, identity);
    if (action === "user.member.card.open") {
      const logged = await supabase.rpc("record_member_card_open", {p_actor:identity.lineUserId});
      if (logged.error) throw new ApiError(503,"AUDIT_UNAVAILABLE","會員卡開啟紀錄暫時無法儲存。");
      return response(origin,{ok:true,status:200,data:{recorded:true}});
    }
    if (action === "user.member.bootstrap") return response(origin, { ok: true, status: 200, data: { profile: await profileFor(supabase, member), ...await termsForMember(supabase, member) } });
    if (action === "user.member.terms.accept") {
      if (member.membership_status !== "active") throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先完成會員申請。");
      await requireCurrentSubmittedTerms(supabase, member, body);
      const accepted = await supabase.rpc("accept_membership_terms_api", {
        p_payload: {
          lineUserId: identity.lineUserId,
          termsId: body.termsId,
          termsVersion: body.termsVersion,
          accepted: body.accepted === true,
        }
      });
      if (accepted.error) await throwTermsOperationError(supabase, member, accepted.error);
      return response(origin, { ok: true, status: 200, data: { profile: await profileFor(supabase, member), ...await termsForMember(supabase, member) } });
    }

    if (member.membership_status === "active" && (await termsForMember(supabase, member)).consentRequired) {
      throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先同意更新後的會員條款。");
    }
    const hasBirthday = Object.prototype.hasOwnProperty.call(body, "birthday");
    const hasPhone = Object.prototype.hasOwnProperty.call(body, "phone");
    const hasSurname = Object.prototype.hasOwnProperty.call(body, "surname");
    const hasSalutation = Object.prototype.hasOwnProperty.call(body, "salutation");
    if (!hasBirthday && !hasPhone && !hasSurname && !hasSalutation) {
      throw new ApiError(400, "PROFILE_FIELDS_REQUIRED", "請提供要修改的會員資料。");
    }

    const birthday = hasBirthday ? asText(body.birthday, 20) : asText(member.birthday, 20);
    const phone = hasPhone ? normalizePhone(body.phone) : normalizePhone(member.phone);
    const surname = hasSurname ? asText(body.surname, 40) : asText(member.surname, 40);
    const salutation = hasSalutation ? asText(body.salutation, 10).toLowerCase() : asText(member.salutation, 10).toLowerCase();

    if (hasBirthday) {
      const parsedBirthday = /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? new Date(`${birthday}T00:00:00Z`) : null;
      const today = new Date();
      const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      if (!parsedBirthday || Number.isNaN(parsedBirthday.getTime()) || parsedBirthday.getTime() > todayUtc) {
        throw new ApiError(400, "INVALID_BIRTHDAY", "請選擇正確的出生年月日，生日不可晚於今天。");
      }
    }
    if (hasPhone && !isValidPhone(phone)) throw new ApiError(400, "INVALID_PHONE", "請選擇國碼並填寫正確的電話號碼。");
    if (hasSurname && (!surname || surname.length > 40)) throw new ApiError(400, "INVALID_SURNAME", "請填寫姓氏。");
    if (hasSalutation && !["mr", "ms"].includes(salutation)) throw new ApiError(400, "INVALID_SALUTATION", "請選擇先生或小姐。");

    const patch: Json = { updated_at: new Date().toISOString() };
    const profileFields: string[] = [];
    if (hasBirthday) { patch.birthday = birthday; profileFields.push("birthday"); }
    if (hasPhone) { patch.phone = phone; profileFields.push("phone"); }
    if (hasSurname) { patch.surname = surname; profileFields.push("surname"); }
    if (hasSalutation) { patch.salutation = salutation; profileFields.push("salutation"); }

    const mergedComplete = Boolean(
      birthday
      && isValidPhone(phone)
      && surname
      && ["mr", "ms"].includes(salutation)
    );
    if (mergedComplete) {
      patch.membership_status = "active";
      patch.joined_at = member.joined_at || new Date().toISOString();
    }

    if (member.membership_status !== "active") {
      if (!mergedComplete) throw new ApiError(400, "PROFILE_FIELDS_REQUIRED", "請填妥完整資料再申請會員。");
      await requireCurrentSubmittedTerms(supabase, member, body);
      const joined = await supabase.rpc("accept_membership_terms_api", {
        p_payload: {
          lineUserId: identity.lineUserId,
          termsId: body.termsId,
          termsVersion: body.termsVersion,
          accepted: body.accepted === true,
          birthday,
          phone,
          surname,
          salutation,
        }
      });
      if (joined.error) await throwTermsOperationError(supabase, member, joined.error);
      const refreshed = await supabase.from("members").select("*").eq("id", member.id).single();
      if (refreshed.error) throw new ApiError(500, "DATABASE_ERROR", "會員資料暫時無法讀取。");
      return response(origin, { ok: true, status: 200, data: { profile: await profileFor(supabase, refreshed.data) } });
    }
    const updated = await supabase.rpc("save_member_profile_audited", {
      p_actor:identity.lineUserId,p_expected_updated_at:member.updated_at,
      p_fields:Object.fromEntries(profileFields.map(field => [field,patch[field]])),
    });
    if (updated.error) throw new ApiError(409,"PROFILE_CONFLICT","會員資料已更新或暫時無法儲存，請重新載入後再試。");
    return response(origin, { ok:true, status:200, data:{ profile:await profileFor(supabase,updated.data) } });

  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "會員資料服務暫時無法完成操作。");
    return response(origin, { ok: false, status: e.status, error: { code: e.code, message: e.message, details: e.details } }, e.status);
  }
});

