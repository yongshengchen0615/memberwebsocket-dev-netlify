import { businessEnv, serveBusiness } from '../_shared/business-runtime.ts';
import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { createClient, SupabaseClient } from '../_shared/business-runtime.ts';
import { workWindow, timeOnBusinessDate, clockTime } from "../_shared/booking-hours.ts";

type Json = Record<string, unknown>;
type Identity = { lineUserId: string; displayName: string };

const MAX_REQUEST_BYTES = 80_000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;
const STORE_SERVICE_ID = "00000000-0000-4000-8000-000000000010";

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

function env(name: string): string { return (businessEnv(name) || "").trim(); }
function allowedOrigins(): Set<string> {
  return new Set([(env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io"), "https://develop--memberwebsocket-dev-netlify.netlify.app"].join(",").split(",").map((v) => v.trim()).filter(Boolean));
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
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" } });
}
function errorResponse(origin: string | null, error: unknown): Response {
  const apiError = error instanceof ApiError ? error : mapDatabaseError(error);
  return response(origin, { ok: false, status: apiError.status, error: { code: apiError.code, message: apiError.message, details: apiError.details } }, apiError.status);
}
function mapDatabaseError(error: unknown): ApiError {
  const raw = error as { message?: string; details?: string; code?: string };
  const message = `${raw?.message || ""} ${raw?.details || ""}`;
  const rules: Array<[string, number, string, string]> = [
    ["BOOKING_SETTINGS_CONFLICT", 409, "BOOKING_SETTINGS_CONFLICT", "預約共用設定已被其他操作更新，請重新整理後再試。"],
    ["BOOKING_SETTINGS_MISSING", 503, "BOOKING_SETTINGS_MISSING", "預約共用設定尚未完成。"],
    ["INVALID_WORK_HOURS", 400, "INVALID_WORK_HOURS", "工作時段至少 5 分鐘，且不可為零長度。"],
    ["INVALID_SLOT_INTERVAL", 400, "INVALID_SLOT_INTERVAL", "切分間隔須為 5–120 分鐘的 5 分鐘倍數。"],
    ["INVALID_ADVANCE_DAYS", 400, "INVALID_ADVANCE_DAYS", "提前預約天數必須介於 0–365 天。"],
    ["INVALID_MAX_ADVANCE_DAYS", 400, "INVALID_MAX_ADVANCE_DAYS", "最遠可預約天數必須介於 0–365 天；0 代表不限制。"],
    ["INVALID_ADVANCE_WINDOW", 400, "INVALID_ADVANCE_WINDOW", "最遠可預約天數不可小於需要提前的天數。"],
    ["INVALID_BOOKING_NOTICE", 400, "INVALID_BOOKING_NOTICE", "預約說明不可超過 2,000 字。"],
    ["INVALID_STORE_SERVICE_MINUTES", 400, "INVALID_STORE_SERVICE_MINUTES", "店內服務分鐘必須介於 1–720 分鐘。"],
    ["BOOKING_STORE_SERVICE_MISSING", 503, "BOOKING_STORE_SERVICE_MISSING", "店內服務系統設定不存在，請聯絡管理員。"],
    ["BOOKING_SERVICE_TYPE_IN_USE", 409, "BOOKING_SERVICE_TYPE_IN_USE", "此項目類型仍有預約項目使用，請先修改或刪除相關預約項目。"],
    ["BOOKING_SERVICE_TYPE_NOT_FOUND", 404, "BOOKING_SERVICE_TYPE_NOT_FOUND", "找不到這個項目類型。"],
    ["DUPLICATE_SERVICE_TYPE", 409, "DUPLICATE_SERVICE_TYPE", "已有相同名稱的項目類型。"],
    ["INVALID_SERVICE_TYPE_NAME", 400, "INVALID_SERVICE_TYPE_NAME", "項目類型名稱必須是 1–80 字。"],
    ["INVALID_BOOKING_REWARD_RULE", 400, "INVALID_BOOKING_REWARD_RULE", "自動集點必須同時設定服務分鐘與集點卡。"],
    ["INVALID_BOOKING_REWARD_MINUTES", 400, "INVALID_BOOKING_REWARD_MINUTES", "自動集點分鐘必須介於 1–10,080 分鐘。"],
    ["BOOKING_REWARD_POINT_CARD_UNAVAILABLE", 409, "BOOKING_REWARD_POINT_CARD_UNAVAILABLE", "所選集點卡目前不可發點，請選擇啟用且未過期的集點卡。"],
    ["BOOKING_SERVICE_TYPE_INVALID", 400, "BOOKING_SERVICE_TYPE_INVALID", "所選項目類型不存在，請重新選擇。"],
    ["BOOKING_SERVICE_NOT_FOUND", 404, "BOOKING_SERVICE_NOT_FOUND", "找不到這個預約項目。"],
    ["BOOKING_SERVICE_CONFLICT", 409, "BOOKING_SERVICE_CONFLICT", "預約項目已被其他操作更新，請重新整理後再試。"],
    ["BOOKING_SYSTEM_SERVICE_IMMUTABLE", 409, "BOOKING_SYSTEM_SERVICE_IMMUTABLE", "店內固定服務不可修改或刪除。"],
    ["INVALID_SERVICE_TITLE", 400, "INVALID_SERVICE_TITLE", "預約項目名稱必須是 1–100 字。"],
    ["INVALID_SERVICE_DURATION", 400, "INVALID_SERVICE_DURATION", "服務時間必須介於 1–720 分鐘。"],
    ["INVALID_SERVICE_PRICE", 400, "INVALID_SERVICE_PRICE", "價格必須是 0–10,000,000 元的整數。"],
    ["INVALID_BATCH_OPERATIONS", 400, "INVALID_BATCH_OPERATIONS", "批次操作必須包含 1–100 筆資料。"],
    ["INVALID_BATCH_OPERATION", 400, "INVALID_BATCH_OPERATION", "批次操作格式不正確。"],
    ["INVALID_SERVICE_ID", 400, "INVALID_SERVICE_ID", "預約項目識別碼格式不正確。"],
  ];
  for (const [needle, status, code, userMessage] of rules) if (message.includes(needle)) return new ApiError(status, code, userMessage);
  if (raw?.code === "23505") return new ApiError(409, "DUPLICATE_VALUE", "資料重複，請使用其他名稱。" );
  return new ApiError(500, "DATABASE_ERROR", "資料庫暫時無法完成預約管理操作。" );
}
function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。" );
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function asText(value: unknown, max = 1000): string { return String(value ?? "").trim().slice(0, max); }
function preserveText(value: unknown, max = 2000): string { return String(value ?? "").replace(/\r\n?/g, "\n").slice(0, max); }
function requireUuid(value: unknown, label: string): string {
  const text = asText(value, 60);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new ApiError(400, "INVALID_INPUT", `${label}格式不正確。`);
  return text;
}
function normalizeTime(value: unknown): string {
  const text = asText(value, 8);
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match) throw new ApiError(400, "INVALID_WORK_HOURS", "時間格式不正確。" );
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || minute % 5 !== 0 || (text.length === 8 && !text.endsWith(":00"))) throw new ApiError(400, "INVALID_WORK_HOURS", "工作時間必須以 5 分鐘為單位。" );
  return `${match[1]}:${match[2]}`;
}
function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
async function verifyLineIdToken(idToken: string): Promise<Identity> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: env("LINE_ADMIN_CHANNEL_ID") || "2010791619",
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  }) as Identity;
}

async function authorizeAdmin(supabase: SupabaseClient, identity: Identity): Promise<void> {
  await requireActiveAdminContract({
    supabase,
    identity,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function consumeRateLimit(supabase: SupabaseClient, identity: Identity, isWrite: boolean): Promise<void> {
  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_principal_hash: await sha256(identity.lineUserId), p_is_write: isWrite, p_cost: 1, p_read_limit: READ_LIMIT, p_write_limit: WRITE_LIMIT,
  });
  if (error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。" );
  if (!data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。" );
}
function settingsClient(row: any, storeService?: any): Json {
  return {
    workStartTime: String(row?.work_start_time || "09:00:00").slice(0, 5),
    workEndTime: String(row?.work_end_time || "17:00:00").slice(0, 5),
    slotIntervalMinutes: Number(row?.slot_interval_minutes || 30),
    minAdvanceDays: Number(row?.min_advance_days || 0),
    maxAdvanceDays: Number(row?.max_advance_days || 0),
    storeServiceMinutes: Number(storeService?.duration_minutes || 10),
    bookingNotice: String(row?.booking_notice || ""),
    reminderEnabled: row?.reminder_enabled === true,
    snapshotLocationRequired: row?.snapshot_location_required === true,
    snapshotLocations: Array.isArray(row?.snapshot_locations) ? row.snapshot_locations : [],
    ticketBookingRequired: row?.ticket_booking_required !== false,
    reminderTime: String(row?.reminder_time || "18:00:00").slice(0, 5),
    updatedAt: row?.updated_at || null,
  };
}
function serviceClient(row: any): Json {
  return { serviceId: row.id, title: row.title, serviceType: row.service_type || "", durationMinutes: Number(row.duration_minutes || 30), priceAmount: Number(row.price_amount || 0), requiresCompanionService: Boolean(row.requires_companion_service), isActive: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at };
}
function typeClient(row: any, reward?: any, card?: any): Json {
  return {
    id: row.id,
    name: row.name,
    sortOrder: Number(row.sort_order || 0),
    rewardMinutesPerPoint: reward ? Number(reward.minutes_per_point || 0) : null,
    rewardPointCardId: reward?.point_card_id || null,
    rewardPointCardTitle: card?.title || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function pointCardClient(row: any): Json {
  return { id: row.id, cardId: row.card_id, title: row.title, status: row.status, expiryMode: row.expiry_mode, expiresOn: row.expires_on || null };
}
function taipeiDateText(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
async function audit(supabase: SupabaseClient, identity: Identity, action: string, targetType: string, targetId: string, metadata: Json = {}): Promise<void> {
  const result = await supabase.from("booking_audit_events").insert({ actor_line_user_id: identity.lineUserId, actor_role: "admin", action, target_type: targetType, target_id: targetId, result: "success", metadata });
  if (result.error) console.error("booking admin audit failed", result.error.message);
}
async function bootstrap(supabase: SupabaseClient): Promise<Json> {
  const [settings, types, services, storeService, rewards, cards] = await Promise.all([
    supabase.from("booking_settings").select("*").eq("id", 1).maybeSingle(),
    supabase.from("booking_service_types").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true }),
    supabase.from("booking_services").select("*").is("deleted_at", null).neq("id", STORE_SERVICE_ID).order("created_at", { ascending: true }),
    supabase.from("booking_services").select("id,duration_minutes,is_active,deleted_at").eq("id", STORE_SERVICE_ID).is("deleted_at", null).maybeSingle(),
    supabase.from("booking_service_type_rewards").select("service_type_id,point_card_id,minutes_per_point"),
    supabase.from("point_cards").select("id,card_id,title,status,expiry_mode,expires_on,sort_order").order("sort_order", { ascending: true }).order("created_at", { ascending: true }),
  ]);
  if (settings.error) throw mapDatabaseError(settings.error);
  if (!settings.data) throw new ApiError(503, "BOOKING_SETTINGS_MISSING", "預約共用設定尚未完成。" );
  if (types.error) throw mapDatabaseError(types.error);
  if (services.error) throw mapDatabaseError(services.error);
  if (storeService.error) throw mapDatabaseError(storeService.error);
  if (rewards.error) throw mapDatabaseError(rewards.error);
  if (cards.error) throw mapDatabaseError(cards.error);
  if (!storeService.data) throw new ApiError(503, "BOOKING_STORE_SERVICE_MISSING", "店內服務系統設定不存在，請聯絡管理員。");

  const rewardByType = new Map((rewards.data || []).map((row: any) => [String(row.service_type_id), row]));
  const cardById = new Map((cards.data || []).map((row: any) => [String(row.id), row]));
  const today = taipeiDateText();
  const availableCards = (cards.data || []).filter((row: any) =>
    row.status === "active" && (row.expiry_mode === "unlimited" || (row.expires_on && String(row.expires_on) >= today))
  );

  return {
    settings: settingsClient(settings.data, storeService.data),
    serviceTypes: (types.data || []).map((row: any) => {
      const reward = rewardByType.get(String(row.id));
      return typeClient(row, reward, reward ? cardById.get(String(reward.point_card_id)) : null);
    }),
    services: (services.data || []).map(serviceClient),
    pointCards: availableCards.map(pointCardClient),
  };
}
async function settingsSave(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const workStartTime = normalizeTime(body.workStartTime);
  const workEndTime = normalizeTime(body.workEndTime);
  let slotIntervalMinutes = Number(body.slotIntervalMinutes);
  if (body.slotIntervalMinutes === undefined) {
    const current = await supabase.from("booking_settings").select("slot_interval_minutes").eq("id", 1).single();
    if (current.error) throw mapDatabaseError(current.error);
    slotIntervalMinutes = Number(current.data.slot_interval_minutes);
  }
  const minAdvanceDays = Number(body.minAdvanceDays);
  const maxAdvanceDays = Number(body.maxAdvanceDays);
  const storeServiceMinutes = Number(body.storeServiceMinutes);
  const bookingNotice = preserveText(body.bookingNotice, 2001);
  // Legacy columns remain for backwards compatibility. Members now control each booking.
  const legacyReminder = await supabase.from("booking_settings")
    .select("reminder_enabled,reminder_time").eq("id", 1).single();
  if (legacyReminder.error) throw mapDatabaseError(legacyReminder.error);
  if (workStartTime === workEndTime || workWindow(workStartTime, workEndTime).end - timeToMinutes(workStartTime) < 5) throw new ApiError(400, "INVALID_WORK_HOURS", "工作時段不可為零長度。" );
  if (!Number.isInteger(slotIntervalMinutes) || slotIntervalMinutes < 5 || slotIntervalMinutes > 120 || slotIntervalMinutes % 5 !== 0) throw new ApiError(400, "INVALID_SLOT_INTERVAL", "切分間隔須為 5–120 分鐘的 5 分鐘倍數。" );
  if (!Number.isInteger(minAdvanceDays) || minAdvanceDays < 0 || minAdvanceDays > 365) throw new ApiError(400, "INVALID_ADVANCE_DAYS", "提前預約天數必須介於 0–365 天。" );
  if (!Number.isInteger(maxAdvanceDays) || maxAdvanceDays < 0 || maxAdvanceDays > 365) throw new ApiError(400, "INVALID_MAX_ADVANCE_DAYS", "最遠可預約天數必須介於 0–365 天；0 代表不限制。" );
  if (maxAdvanceDays > 0 && maxAdvanceDays < minAdvanceDays) throw new ApiError(400, "INVALID_ADVANCE_WINDOW", "最遠可預約天數不可小於需要提前的天數。" );
  if (!Number.isInteger(storeServiceMinutes) || storeServiceMinutes < 1 || storeServiceMinutes > 720) throw new ApiError(400, "INVALID_STORE_SERVICE_MINUTES", "店內服務分鐘必須介於 1–720 分鐘。" );
  if (bookingNotice.length > 2000) throw new ApiError(400, "INVALID_BOOKING_NOTICE", "預約說明不可超過 2,000 字。" );
  if (body.snapshotLocationRequired !== undefined && typeof body.snapshotLocationRequired !== "boolean") throw new ApiError(400, "INVALID_SNAPSHOT_LOCATION_POLICY", "請選擇是否要求快照定位。");
  if (body.ticketBookingRequired !== undefined && typeof body.ticketBookingRequired !== "boolean") throw new ApiError(400, "INVALID_TICKET_BOOKING_POLICY", "請選擇使用票券是否需要預約。");
  const snapshotLocations = body.snapshotLocations;
  if (!Array.isArray(snapshotLocations) || snapshotLocations.length > 20 || snapshotLocations.some((location: any) =>
    !location || typeof location !== "object" || typeof location.name !== "string"
    || !location.name.trim() || location.name.trim().length > 100
    || typeof location.latitude !== "number" || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
    || typeof location.longitude !== "number" || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180
    || !Number.isInteger(location.radiusMeters) || location.radiusMeters < 50 || location.radiusMeters > 2000)) {
    throw new ApiError(400, "SNAPSHOT_LOCATION_CONFIG_INVALID", "快照地點名稱、座標或半徑設定不正確。");
  }
  if (body.snapshotLocationRequired === true && snapshotLocations.length === 0) {
    throw new ApiError(400, "SNAPSHOT_LOCATION_NOT_CONFIGURED", "請先設定至少一個允許快照的地點。");
  }
  const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
  const result = await supabase.rpc("save_booking_shared_settings_v7", {
    p_snapshot_locations: snapshotLocations,
    p_ticket_booking_required: body.ticketBookingRequired ?? null,
    p_snapshot_location_required: body.snapshotLocationRequired ?? null,
    p_work_start_time: `${workStartTime}:00`,
    p_work_end_time: `${workEndTime}:00`,
    p_slot_interval_minutes: slotIntervalMinutes,
    p_min_advance_days: minAdvanceDays,
    p_max_advance_days: maxAdvanceDays,
    p_booking_notice: bookingNotice,
    p_store_service_minutes: storeServiceMinutes,
    p_reminder_enabled: legacyReminder.data.reminder_enabled === true,
    p_reminder_time: legacyReminder.data.reminder_time,
    p_expected_updated_at: expectedUpdatedAt || null,
    p_actor: identity.lineUserId,
  });
  if (result.error) throw mapDatabaseError(result.error);
  const settings = settingsClient(result.data, { duration_minutes: storeServiceMinutes });
  const previewDate = taipeiDateText();
  const window = workWindow(workStartTime, workEndTime);
  return { settings, preview: { businessDate: previewDate, startAt: timeOnBusinessDate(previewDate, window.start), endAt: timeOnBusinessDate(previewDate, window.end), firstSlots: Array.from({ length: Math.min(4, Math.ceil((window.end - window.start) / slotIntervalMinutes)) }, (_, n) => clockTime(window.start + n * slotIntervalMinutes)) } };
}
function normalizeRewardRule(body: Json): { provided: boolean; minutes: number | null; pointCardId: string | null } {
  const provided = Object.prototype.hasOwnProperty.call(body, "rewardMinutesPerPoint")
    || Object.prototype.hasOwnProperty.call(body, "rewardPointCardId");
  if (!provided) return { provided: false, minutes: null, pointCardId: null };

  const rawMinutes = body.rewardMinutesPerPoint;
  const rawCard = asText(body.rewardPointCardId, 60);
  const disabled = (rawMinutes === null || rawMinutes === undefined || rawMinutes === "" || Number(rawMinutes) === 0) && !rawCard;
  if (disabled) return { provided: true, minutes: null, pointCardId: null };

  const minutes = Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
    throw new ApiError(400, "INVALID_BOOKING_REWARD_MINUTES", "自動集點分鐘必須介於 1–10,080 分鐘。");
  }
  if (!rawCard) throw new ApiError(400, "INVALID_BOOKING_REWARD_RULE", "請選擇要自動加點的集點卡。");
  return { provided: true, minutes, pointCardId: requireUuid(rawCard, "集點卡") };
}

async function typeCreate(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const name = asText(body.name, 80);
  if (!name) throw new ApiError(400, "INVALID_SERVICE_TYPE_NAME", "項目類型名稱必須是 1–80 字。" );
  const reward = normalizeRewardRule(body);
  const result = await supabase.rpc("save_booking_service_type", {
    p_type_id: null,
    p_name: name,
    p_reward_minutes_per_point: reward.minutes,
    p_reward_point_card_id: reward.pointCardId,
    p_actor: identity.lineUserId,
  });
  if (result.error) throw mapDatabaseError(result.error);
  await audit(supabase, identity, "BOOKING_SERVICE_TYPE_CREATED", "booking_service_type", String(result.data?.id || ""), {
    name, rewardMinutesPerPoint: reward.minutes, rewardPointCardId: reward.pointCardId,
  });
  return await bootstrap(supabase);
}

async function typeUpdate(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const typeId = requireUuid(body.typeId, "項目類型");
  const name = asText(body.name, 80);
  if (!name) throw new ApiError(400, "INVALID_SERVICE_TYPE_NAME", "項目類型名稱必須是 1–80 字。" );

  let reward = normalizeRewardRule(body);
  if (!reward.provided) {
    const current = await supabase.from("booking_service_type_rewards")
      .select("minutes_per_point,point_card_id")
      .eq("service_type_id", typeId)
      .maybeSingle();
    if (current.error) throw mapDatabaseError(current.error);
    reward = {
      provided: false,
      minutes: current.data ? Number(current.data.minutes_per_point) : null,
      pointCardId: current.data?.point_card_id || null,
    };
  }

  const result = await supabase.rpc("save_booking_service_type", {
    p_type_id: typeId,
    p_name: name,
    p_reward_minutes_per_point: reward.minutes,
    p_reward_point_card_id: reward.pointCardId,
    p_actor: identity.lineUserId,
  });
  if (result.error) throw mapDatabaseError(result.error);
  await audit(supabase, identity, "BOOKING_SERVICE_TYPE_UPDATED", "booking_service_type", typeId, {
    name, rewardMinutesPerPoint: reward.minutes, rewardPointCardId: reward.pointCardId,
  });
  return await bootstrap(supabase);
}
async function typeDelete(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const typeId = requireUuid(body.typeId, "項目類型");
  const result = await supabase.rpc("delete_booking_service_type", { p_type_id: typeId, p_actor: identity.lineUserId });
  if (result.error) throw mapDatabaseError(result.error);
  await audit(supabase, identity, "BOOKING_SERVICE_TYPE_DELETED", "booking_service_type", typeId);
  return await bootstrap(supabase);
}
async function serviceSave(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const serviceId = asText(body.serviceId, 60);
  if (serviceId) requireUuid(serviceId, "預約項目");
  if (serviceId === STORE_SERVICE_ID) throw new ApiError(409, "BOOKING_SYSTEM_SERVICE_IMMUTABLE", "店內固定服務不可修改或刪除。" );
  const title = asText(body.title, 100);
  const typeInput = asText(body.serviceType, 80);
  const durationMinutes = Number(body.durationMinutes);
  const priceAmount = Number(body.priceAmount);
  const requiresCompanionProvided = Object.prototype.hasOwnProperty.call(body, "requiresCompanionService");
  const requestedRequiresCompanionService = body.requiresCompanionService === true;
  let requiresCompanionService = requestedRequiresCompanionService;
  const isActive = body.isActive !== false;
  if (!title) throw new ApiError(400, "INVALID_SERVICE_TITLE", "預約項目名稱不可空白。" );
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) throw new ApiError(400, "INVALID_SERVICE_DURATION", "服務時間必須介於 1–720 分鐘。" );
  if (!Number.isSafeInteger(priceAmount) || priceAmount < 0 || priceAmount > 10_000_000) throw new ApiError(400, "INVALID_SERVICE_PRICE", "價格必須是 0–10,000,000 元的整數。" );
  const typeResult = await supabase.from("booking_service_types").select("name").ilike("name", typeInput).maybeSingle();
  if (typeResult.error) throw mapDatabaseError(typeResult.error);
  if (!typeResult.data) throw new ApiError(400, "BOOKING_SERVICE_TYPE_INVALID", "所選項目類型不存在，請重新選擇。" );
  const serviceType = typeResult.data.name;
  let saved: any;
  if (serviceId) {
    const current = await supabase.from("booking_services").select("updated_at,requires_companion_service").eq("id", serviceId).is("deleted_at", null).maybeSingle();
    if (current.error) throw mapDatabaseError(current.error);
    if (!current.data) throw new ApiError(404, "BOOKING_SERVICE_NOT_FOUND", "找不到這個預約項目。" );
    const expected = asText(body.expectedUpdatedAt, 80);
    if (expected && new Date(current.data.updated_at).getTime() !== new Date(expected).getTime()) throw new ApiError(409, "BOOKING_SERVICE_CONFLICT", "預約項目已被其他操作更新，請重新整理後再試。" );
    requiresCompanionService = requiresCompanionProvided ? requestedRequiresCompanionService : Boolean(current.data.requires_companion_service);
    const patch = { title, description: `__TYPE__:${serviceType}`, service_type: serviceType, duration_minutes: durationMinutes, price_amount: priceAmount, requires_companion_service: requiresCompanionService, is_active: isActive, counts_toward_membership: true };
    const updated = await supabase.from("booking_services").update(patch)
      .eq("id", serviceId)
      .is("deleted_at", null)
      .eq("updated_at", current.data.updated_at)
      .select("*")
      .maybeSingle();
    if (updated.error) throw mapDatabaseError(updated.error);
    if (!updated.data) throw new ApiError(409, "BOOKING_SERVICE_CONFLICT", "預約項目已被其他操作更新，請重新整理後再試。" );
    saved = updated.data;
    await audit(supabase, identity, "BOOKING_SERVICE_UPDATED", "booking_service", serviceId, { durationMinutes, priceAmount, serviceType, requiresCompanionService });
  } else {
    const patch = { title, description: `__TYPE__:${serviceType}`, service_type: serviceType, duration_minutes: durationMinutes, price_amount: priceAmount, requires_companion_service: requiresCompanionService, is_active: isActive, counts_toward_membership: true };
    const inserted = await supabase.from("booking_services").insert({ ...patch, created_by: identity.lineUserId }).select("*").single();
    if (inserted.error) throw mapDatabaseError(inserted.error);
    saved = inserted.data;
    await audit(supabase, identity, "BOOKING_SERVICE_CREATED", "booking_service", String(saved.id), { durationMinutes, priceAmount, serviceType, requiresCompanionService });
  }
  return { service: serviceClient(saved) };
}
async function serviceDelete(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const serviceId = requireUuid(body.serviceId, "預約項目");
  const operation = { op: "delete", serviceId, expectedUpdatedAt: asText(body.expectedUpdatedAt, 80) };
  const result = await supabase.rpc("apply_booking_service_batch", { p_operations: [operation], p_actor: identity.lineUserId });
  if (result.error) throw mapDatabaseError(result.error);
  await audit(supabase, identity, "BOOKING_SERVICE_DELETED", "booking_service", serviceId);
  return { summary: result.data };
}
async function servicesBatch(supabase: SupabaseClient, identity: Identity, body: Json): Promise<Json> {
  const operations = Array.isArray(body.operations) ? body.operations : [];
  if (!operations.length || operations.length > 100) throw new ApiError(400, "INVALID_BATCH_OPERATIONS", "批次操作必須包含 1–100 筆資料。" );
  const result = await supabase.rpc("apply_booking_service_batch", { p_operations: operations, p_actor: identity.lineUserId });
  if (result.error) throw mapDatabaseError(result.error);
  await audit(supabase, identity, "BOOKING_SERVICES_BATCH_APPLIED", "booking_service_batch", crypto.randomUUID(), { count: operations.length, summary: result.data as Json });
  return { summary: result.data };
}

async function route(supabase: SupabaseClient, identity: Identity, action: string, body: Json): Promise<Json> {
  if (action === "admin.booking.manage.bootstrap") return await bootstrap(supabase);
  if (action === "admin.booking.settings.save") return await settingsSave(supabase, identity, body);
  if (action === "admin.booking.type.create") return await typeCreate(supabase, identity, body);
  if (action === "admin.booking.type.update") return await typeUpdate(supabase, identity, body);
  if (action === "admin.booking.type.delete") return await typeDelete(supabase, identity, body);
  if (action === "admin.booking.service.save") return await serviceSave(supabase, identity, body);
  if (action === "admin.booking.service.delete") return await serviceDelete(supabase, identity, body);
  if (action === "admin.booking.services.batch") return await servicesBatch(supabase, identity, body);
  throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的預約管理操作。" );
}

serveBusiness('booking-admin-api',async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return response(origin, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支援 POST。" } }, 405);
  if (origin && !allowedOrigins().has(origin)) return response(origin, { ok: false, error: { code: "ORIGIN_DENIED", message: "不允許的來源。" } }, 403);
  try {
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);

    const action = asText(body.action, 100);
    if (!action.startsWith("admin.booking.")) throw new ApiError(403, "CLIENT_ACTION_MISMATCH", "操作端與功能不相符。" );
    const identity = await verifyLineIdToken(asText(body.idToken, 5000));
    const supabase = dbClient();
    await authorizeAdmin(supabase, identity);
    await consumeRateLimit(supabase, identity, action !== "admin.booking.manage.bootstrap");
    const data = await route(supabase, identity, action, body);
    return response(origin, { ok: true, status: 200, data });
  } catch (error) { return errorResponse(origin, error); }
});
