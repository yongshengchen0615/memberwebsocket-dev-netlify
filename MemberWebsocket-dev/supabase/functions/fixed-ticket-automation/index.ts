import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

type Json = Record<string, unknown>;

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TIER_KEYS = ["general", "silver", "gold", "platinum"] as const;
const SCHEDULE_TYPES = ["birthday_month", "yearly", "monthly", "weekly"] as const;
const EXPIRY_MODES = ["month_end", "week_end", "days_after_issue", "fixed_date"] as const;

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function asText(value: unknown, max = 1000): string { return String(value ?? "").trim().slice(0, max); }
function taipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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
    "Cache-Control":"no-store",
    "Vary":"Origin",
  };
}

function reply(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

async function verifyAdmin(supabase: SupabaseClient, idToken: string): Promise<{ lineUserId: string; displayName: string }> {
  if (!idToken) throw new ApiError(401, "AUTH_REQUIRED", "請先使用 LINE 管理端登入。");
  const channelId = env("LINE_ADMIN_CHANNEL_ID") || "2010791619";
  let response: Response;
  try {
    response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
  } catch {
    throw new ApiError(503, "LINE_AUTH_UNAVAILABLE", "LINE 身分驗證服務暫時無法使用。");
  }

  const payload: Json = await response.json().catch(() => ({}));
  const sub = asText(payload.sub, 120);
  const aud = asText(payload.aud, 60);
  const iss = asText(payload.iss, 100);
  const exp = Number(payload.exp || 0);
  if (!response.ok || !sub || aud !== channelId || iss !== "https://access.line.me" || !Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new ApiError(401, "AUTH_INVALID", "LINE 登入已失效，請重新登入。");
  }

  const admin = await supabase.from("admins").select("role,status").eq("line_user_id", sub).maybeSingle();
  if (admin.error) throw new ApiError(500, "DATABASE_ERROR", "無法確認管理員權限。");
  if (!admin.data || admin.data.status !== "active" || admin.data.role !== "admin") {
    throw new ApiError(403, "ADMIN_REQUIRED", "此功能僅限已授權管理員使用。");
  }
  return { lineUserId: sub, displayName: asText(payload.name || "管理員", 120) };
}

function normalizeTiers(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.map((item) => asText(item, 20)).filter((item) => (TIER_KEYS as readonly string[]).includes(item))
    : [];
  return [...new Set(values)];
}

function requireInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(400, "INVALID_INPUT", `${label}必須是 ${min}–${max} 的整數。`);
  }
  return number;
}

function requireDate(value: unknown, label: string): string {
  const text = asText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ApiError(400, "INVALID_INPUT", `${label}格式不正確。`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ApiError(400, "INVALID_INPUT", `${label}格式不正確。`);
  }
  return text;
}


function normalizeRedemptionLocations(value: unknown, requiresLocation: boolean): Array<{ name: string; latitude: number; longitude: number; radiusMeters: number }> {
  if (!requiresLocation) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new ApiError(400, "INVALID_LOCATION_RULE", "請設定 1–20 個核銷地點。");
  }
  return value.map((raw) => {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const name = asText(item.name, 100);
    const latitude = item.latitude === "" || item.latitude == null ? NaN : Number(item.latitude);
    const longitude = item.longitude === "" || item.longitude == null ? NaN : Number(item.longitude);
    const radiusMeters = item.radiusMeters === "" || item.radiusMeters == null ? NaN : Number(item.radiusMeters);
    if (!name || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isInteger(radiusMeters) || radiusMeters < 50 || radiusMeters > 2000) {
      throw new ApiError(400, "INVALID_LOCATION_RULE", "每個地點需有名稱、有效座標與 50–2000 公尺半徑。");
    }
    return { name, latitude, longitude, radiusMeters };
  });
}

function validateTemplate(value: unknown): Json {
  const input = value && typeof value === "object" ? value as Json : {};
  if (input.notifyLine !== undefined && typeof input.notifyLine !== "boolean") throw new ApiError(400,"INVALID_INPUT","LINE 通知啟用設定必須是布林值。");
  const title = asText(input.title, 100);
  const description = asText(input.description, 240);
  const usageMethod = asText(input.usageMethod, 120);
  const usageInstructions = asText(input.usageInstructions, 500);
  const status = asText(input.status, 20);
  const scheduleType = asText(input.scheduleType, 30);
  const expiryMode = asText(input.expiryMode, 30) || "month_end";
  const accent = asText(input.accent, 20).toLowerCase();
  const allowedTierKeys = normalizeTiers(input.allowedTierKeys);
  const quota = requireInteger(input.quota ?? 0, 0, 1_000_000, "總發放上限");
  const requiresLocation = input.requiresLocation === true;
  const redemptionLocations = normalizeRedemptionLocations(input.redemptionLocations, requiresLocation);

  if (!title) throw new ApiError(400, "INVALID_INPUT", "請填寫固定票券名稱。");
  if (!description) throw new ApiError(400, "INVALID_INPUT", "請填寫固定票券說明。");
  if (!usageMethod) throw new ApiError(400, "INVALID_INPUT", "請填寫使用方式。");
  if (!usageInstructions) throw new ApiError(400, "INVALID_INPUT", "請填寫使用說明。");
  if (!["active", "draft", "archived"].includes(status)) throw new ApiError(400, "INVALID_STATUS", "請選擇公開狀態。");
  if (!(SCHEDULE_TYPES as readonly string[]).includes(scheduleType)) throw new ApiError(400, "INVALID_SCHEDULE", "請選擇固定票券發放週期。");
  if (!(EXPIRY_MODES as readonly string[]).includes(expiryMode)) throw new ApiError(400, "INVALID_EXPIRY_MODE", "請選擇固定票券使用期限。");
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new ApiError(400, "INVALID_ACCENT", "識別色格式不正確。");
  if (!allowedTierKeys.length) throw new ApiError(400, "INVALID_TIERS", "請至少選擇一個適用會員等級。");

  let scheduleMonth: number | null = null;
  let scheduleDay: number | null = null;
  let scheduleWeekday: number | null = null;
  if (scheduleType === "yearly") {
    scheduleMonth = requireInteger(input.scheduleMonth, 1, 12, "月份");
    scheduleDay = requireInteger(input.scheduleDay, 1, 31, "日期");
  } else if (scheduleType === "monthly") {
    scheduleDay = requireInteger(input.scheduleDay, 1, 31, "日期");
  } else if (scheduleType === "weekly") {
    scheduleWeekday = requireInteger(input.scheduleWeekday, 1, 7, "星期");
  }

  let expiryDate: string | null = null;
  let expiryDays: number | null = null;
  if (expiryMode === "fixed_date") {
    expiryDate = requireDate(input.expiryDate, "指定到期日");
    if (expiryDate < taipeiDate()) throw new ApiError(400, "INVALID_EXPIRY_DATE", "指定到期日不可早於今天。");
  } else if (expiryMode === "days_after_issue") {
    expiryDays = requireInteger(input.expiryDays, 1, 3650, "發放後使用天數");
  }

  return {
    fixed_ticket_id: asText(input.fixedTicketId, 80),
    title,
    description,
    usage_method: usageMethod,
    usage_instructions: usageInstructions,
    status,
    schedule_type: scheduleType,
    schedule_month: scheduleMonth,
    schedule_day: scheduleDay,
    schedule_weekday: scheduleWeekday,
    expiry_mode: expiryMode,
    expiry_date: expiryDate,
    expiry_days: expiryDays,
    quota,
    accent,
    allowed_tier_keys: allowedTierKeys,
    requires_location: requiresLocation,
    redemption_locations: redemptionLocations,
    notify_line: Boolean(input.notifyLine),
    notify_time: notificationTime(input.notifyTime),
    calendar_enabled: Boolean(input.calendarEnabled),
  };
}

function notificationTime(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ApiError(400,"INVALID_INPUT","LINE 通知時間必須是台北時間 HH:mm。");
  return value;
}

function clientTemplate(row: any): Json {
  return {
    fixedTicketId: row.fixed_ticket_id,
    title: row.title,
    description: row.description || "",
    usageMethod: row.usage_method || "",
    usageInstructions: row.usage_instructions || "",
    status: row.status,
    scheduleType: row.schedule_type,
    scheduleMonth: row.schedule_month,
    scheduleDay: row.schedule_day,
    scheduleWeekday: row.schedule_weekday,
    expiryMode: row.expiry_mode || "month_end",
    expiryDate: row.expiry_date || "",
    expiryDays: row.expiry_days == null ? null : Number(row.expiry_days),
    quota: Number(row.quota || 0),
    accent: row.accent || "#df6b4d",
    allowedTierKeys: Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [...TIER_KEYS],
    requiresLocation: Boolean(row.requires_location),
    redemptionLocations: Array.isArray(row.redemption_locations) ? row.redemption_locations : [],
    notifyLine: Boolean(row.notify_line),
    notifyTime: row.notify_time ? String(row.notify_time).slice(0,5) : null,
    calendarEnabled: Boolean(row.calendar_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listTemplates(supabase: SupabaseClient): Promise<Json[]> {
  const result = await supabase
    .from("fixed_ticket_templates")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (result.error) throw new ApiError(500, "DATABASE_ERROR", "固定票券設定暫時無法讀取。");
  return (result.data || []).map(clientTemplate);
}

async function audit(supabase: SupabaseClient, actor: string, action: string, targetId: string, detail: Json): Promise<void> {
  await supabase.from("audit_logs").insert({
    audit_id: "AUD-" + crypto.randomUUID().replaceAll("-", ""),
    actor_line_user_id: actor,
    actor_role: "admin",
    action,
    target_type: "fixed_ticket_template",
    target_id: targetId,
    result: "success",
    detail,
  });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return reply(origin, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支援 POST。" } }, 405);
  if (origin && !allowedOrigins().has(origin)) return reply(origin, { ok: false, error: { code: "ORIGIN_DENIED", message: "不允許的來源。" } }, 403);

  try {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 30_000) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "請求內容過大。");
    const body: Json = await request.json().catch(() => ({}));
    const action = asText(body.action, 80);
    const supabase = dbClient();
    const identity = await verifyAdmin(supabase, asText(body.idToken, 10_000));

    if (action === "admin.fixed-tickets.list") {
      return reply(origin, { ok: true, data: { templates: await listTemplates(supabase) } });
    }

    if (action === "admin.fixed-tickets.save") {
      const patch = validateTemplate(body.template);
      const fixedTicketId = asText(patch.fixed_ticket_id, 80);
      let row: any;

      if (fixedTicketId) {
        const current = await supabase
          .from("fixed_ticket_templates")
          .select("*")
          .eq("fixed_ticket_id", fixedTicketId)
          .is("deleted_at", null)
          .maybeSingle();
        if (current.error || !current.data) throw new ApiError(404, "FIXED_TICKET_NOT_FOUND", "找不到指定固定票券。");
        if ((body.template as Json)?.notifyTime === undefined) patch.notify_time = current.data.notify_time || null;
        const expected = asText(body.expectedUpdatedAt, 100);
        if (expected && expected !== current.data.updated_at) throw new ApiError(409, "CONFLICT", "固定票券已被其他管理者更新，請重新整理後再試。");

        const updated = await supabase
          .from("fixed_ticket_templates")
          .update({ ...patch, fixed_ticket_id: fixedTicketId, updated_by: identity.lineUserId, updated_at: new Date().toISOString(), deleted_at: null })
          .eq("id", current.data.id)
          .select("*")
          .single();
        if (updated.error) throw new ApiError(500, "DATABASE_ERROR", "固定票券暫時無法儲存。");
        row = updated.data;
      } else {
        const newId = "FT-" + crypto.randomUUID().replaceAll("-", "").slice(0, 14).toUpperCase();
        const inserted = await supabase
          .from("fixed_ticket_templates")
          .insert({ ...patch, fixed_ticket_id: newId, created_by: identity.lineUserId, updated_by: identity.lineUserId })
          .select("*")
          .single();
        if (inserted.error) throw new ApiError(500, "DATABASE_ERROR", "固定票券暫時無法建立。");
        row = inserted.data;
      }

      let run: unknown = null;
      if (row.status === "active") {
        const issued = await supabase.rpc("issue_fixed_tickets", { p_business_date: taipeiDate(), p_member_id: null, p_template_id: row.id });
        if (issued.error) throw new ApiError(500, "ISSUE_FAILED", "固定票券已儲存，但自動發放檢查失敗。");
        run = issued.data;
      }

      await audit(supabase, identity.lineUserId, "admin.fixed-tickets.save", row.fixed_ticket_id, {
        status: row.status,
        scheduleType: row.schedule_type,
        expiryMode: row.expiry_mode,
        expiryDate: row.expiry_date,
        expiryDays: row.expiry_days,
        calendarEnabled: Boolean(row.calendar_enabled),
        notifyLine: Boolean(row.notify_line),
        notifyTime: row.notify_time ? String(row.notify_time).slice(0,5) : null,
        requiresLocation: Boolean(row.requires_location),
        redemptionLocationCount: Array.isArray(row.redemption_locations) ? row.redemption_locations.length : 0,
        run,
      });
      return reply(origin, { ok: true, data: { template: clientTemplate(row), run, templates: await listTemplates(supabase) } });
    }

    if (action === "admin.fixed-tickets.delete") {
      const fixedTicketId = asText(body.fixedTicketId, 80);
      if (!fixedTicketId) throw new ApiError(400, "INVALID_INPUT", "缺少固定票券識別。");
      const current = await supabase.from("fixed_ticket_templates").select("*").eq("fixed_ticket_id", fixedTicketId).is("deleted_at", null).maybeSingle();
      if (current.error || !current.data) throw new ApiError(404, "FIXED_TICKET_NOT_FOUND", "找不到指定固定票券。");
      const expected = asText(body.expectedUpdatedAt, 100);
      if (expected && expected !== current.data.updated_at) throw new ApiError(409, "CONFLICT", "固定票券已被其他管理者更新，請重新整理後再試。");
      const now = new Date().toISOString();
      const result = await supabase.from("fixed_ticket_templates").update({ status: "archived", deleted_at: now, updated_by: identity.lineUserId, updated_at: now }).eq("id", current.data.id);
      if (result.error) throw new ApiError(500, "DATABASE_ERROR", "固定票券暫時無法刪除。");
      await audit(supabase, identity.lineUserId, "admin.fixed-tickets.delete", fixedTicketId, {});
      return reply(origin, { ok: true, data: { deleted: true, fixedTicketId, templates: await listTemplates(supabase) } });
    }

    if (action === "admin.fixed-tickets.run") {
      const fixedTicketId = asText(body.fixedTicketId, 80);
      let templateId: string | null = null;
      if (fixedTicketId) {
        const current = await supabase.from("fixed_ticket_templates").select("id").eq("fixed_ticket_id", fixedTicketId).is("deleted_at", null).maybeSingle();
        if (current.error || !current.data) throw new ApiError(404, "FIXED_TICKET_NOT_FOUND", "找不到指定固定票券。");
        templateId = String(current.data.id);
      }
      const issued = await supabase.rpc("issue_fixed_tickets", { p_business_date: taipeiDate(), p_member_id: null, p_template_id: templateId });
      if (issued.error) throw new ApiError(500, "ISSUE_FAILED", "固定票券發放檢查失敗。");
      await audit(supabase, identity.lineUserId, "admin.fixed-tickets.run", fixedTicketId || "all", { run: issued.data });
      return reply(origin, { ok: true, data: { run: issued.data, templates: await listTemplates(supabase) } });
    }

    throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的固定票券操作。");
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "固定票券服務暫時無法完成操作。");
    return reply(origin, { ok: false, error: { code: apiError.code, message: apiError.message } }, apiError.status);
  }
});
