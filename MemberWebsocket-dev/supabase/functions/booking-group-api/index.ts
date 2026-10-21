import { businessEnv, serveBusiness } from '../_shared/business-runtime.ts';
import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { resolveUserTestIdentity, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import { createClient, SupabaseClient } from '../_shared/business-runtime.ts';
import { workWindow, clockTime, occupiedRange, localRange, slotHasPassed, timeOnBusinessDate, localTimestamp, currentBusinessDate } from "../_shared/booking-hours.ts";

type Json = Record<string, any>;
type Identity = { lineUserId: string; displayName: string };
type ClientType = "member" | "admin";
const STORE_SERVICE_ID = "00000000-0000-4000-8000-000000000010";
const SLOT_INTERVAL = 30;
const MAX_REQUEST_BYTES = 40000;
const READ_LIMIT = 90;
const WRITE_LIMIT = 30;
const WRITE_ACTIONS = new Set([
  "user.booking.group.create",
  "user.booking.group.update",
  "admin.booking.resources.settings.save",
  "admin.booking.resources.technician.save",
]);

class ApiError extends Error {
  status: number; code: string; details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}

const env = (name: string) => (businessEnv(name) || "").trim();
function allowedOrigins() {
  return new Set([(env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io"), "https://develop--memberwebsocket-dev-netlify.netlify.app"].join(",").split(",").map((v) => v.trim()).filter(Boolean));
}
function cors(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins().has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function reply(origin: string | null, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8" } });
}
function mapDbError(error: any): ApiError {
  const text = `${error?.message || ""} ${error?.details || ""}`;
  const rules: Array<[string, number, string, string]> = [
    ["FRIEND_NOT_FOUND",404,"FRIEND_NOT_FOUND","受服務好友目前無法預約。"],
    ["FRIEND_ACCEPTED_REQUIRED",403,"FRIEND_ACCEPTED_REQUIRED","好友需要接受邀請後才能代約。"],
    ["FRIEND_SINGLE_RECIPIENT_REQUIRED",400,"FRIEND_SINGLE_RECIPIENT_REQUIRED","代好友預約請選擇單人服務。"],
    ["REQUEST_ID_CONFLICT",409,"REQUEST_ID_CONFLICT","同一操作識別不可更換受服務者。"],
    ["BOOKING_RESTRICTED",403,"BOOKING_RESTRICTED","目前暫停線上預約，請重新整理查看到期時間與聯絡方式。"],
    ["BOOKING_SLOT_TAKEN",409,"BOOKING_SLOT_TAKEN","選擇的技師在這段時間剛被預約，請選擇其他時間。"],
    ["INVALID_BOOKING_BENEFITS",400,"INVALID_BOOKING_BENEFITS","選用優惠資料格式不正確。"],
    ["EVENT_TICKET_ALREADY_REGISTERED",409,"EVENT_TICKET_ALREADY_REGISTERED","這張活動票券已在一般預約或快照模式登記，不能重複登記。"],
    ["BOOKING_BENEFIT_NOT_AVAILABLE",409,"BOOKING_BENEFIT_NOT_AVAILABLE","其中一項優惠目前已不可使用，請重新整理後再選擇。"],
    ["BOOKING_BENEFIT_LOCATION_REQUIRED",409,"BOOKING_BENEFIT_LOCATION_REQUIRED","其中一張票券需要定位核銷，無法綁定至預約自動核銷。"],
    ["BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED",409,"BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED","已核銷票券所需的服務項目不能移除。"],
    ["BOOKING_BENEFIT_SERVICE_REQUIRED",409,"BOOKING_BENEFIT_SERVICE_REQUIRED","所選票券需要預約指定項目，請確認本次預約項目後再試。"],
    ["POINT_TICKET_INSUFFICIENT_POINTS",409,"POINT_TICKET_INSUFFICIENT_POINTS","集點卡點數不足，請取消部分票券後再預約。"],
    ["BOOKING_CONFLICT",409,"BOOKING_CONFLICT","預約已被更新，請重新整理後再操作。"],
    ["BOOKING_CANCELLATION_PENDING",409,"BOOKING_CANCELLATION_PENDING","這筆預約已有待確認的取消申請，請先完成取消審核後再修改。"],
    ["BOOKING_NOT_EDITABLE",409,"BOOKING_NOT_EDITABLE","這筆預約目前無法修改。"],
    ["BOOKING_TOO_EARLY",409,"BOOKING_TOO_EARLY","尚未符合提前預約天數。"],
    ["BOOKING_TOO_FAR",409,"BOOKING_TOO_FAR","此日期超過可預約範圍。"],
    ["BOOKING_TIME_PASSED",409,"BOOKING_TIME_PASSED","這個預約時間已經過了。"],
    ["BOOKING_SERVICE_DISABLED",409,"BOOKING_SERVICE_DISABLED","其中一個預約項目目前未開放。"],
    ["BOOKING_ADD_ON_REQUIRES_COMPANION",400,"BOOKING_ADD_ON_REQUIRES_COMPANION","加購項目不能單獨預約，請至少再選擇一個一般項目。"],
    ["BOOKING_SERVICE_NOT_FOUND",404,"BOOKING_SERVICE_NOT_FOUND","找不到其中一個預約項目。"],
    ["BOOKING_TECHNICIAN_NOT_FOUND",404,"BOOKING_TECHNICIAN_NOT_FOUND","找不到選擇的技師。"],
    ["BOOKING_TECHNICIAN_DISABLED",409,"BOOKING_TECHNICIAN_DISABLED","選擇的技師目前未開放預約。"],
    ["BOOKING_PRIMARY_TECHNICIAN_MISSING",409,"BOOKING_PRIMARY_TECHNICIAN_MISSING","管理端尚未設定主要技師，暫時無法建立預約。"],
    ["BOOKING_PRIMARY_TECHNICIAN_DISABLED",409,"BOOKING_PRIMARY_TECHNICIAN_DISABLED","主要技師目前未開放預約，請聯絡店家。"],
    ["BOOKING_PRIMARY_TECHNICIAN_REQUIRED",400,"BOOKING_PRIMARY_TECHNICIAN_REQUIRED","每筆預約至少要有一位選擇主要技師。"],
    ["DUPLICATE_PARTICIPANT_TECHNICIAN",400,"DUPLICATE_PARTICIPANT_TECHNICIAN","同一筆多人預約中，同一位技師不能同時安排給兩位預約人。"],
    ["INVALID_PARTY_SIZE",400,"INVALID_PARTY_SIZE","預約人數超出目前允許範圍。"],
    ["INVALID_BOOKING_PARTICIPANTS",400,"INVALID_BOOKING_PARTICIPANTS","預約人員資料格式不正確。"],
    ["INVALID_BOOKING_ITEMS",400,"INVALID_BOOKING_ITEMS","每一位預約人都至少要選擇一個預約項目。"],
    ["INVALID_BOOKING_QUANTITY",400,"INVALID_BOOKING_QUANTITY","同一位預約人的單一項目最多選擇 2 次。"],
    ["DUPLICATE_BOOKING_SERVICE",400,"DUPLICATE_BOOKING_SERVICE","同一位預約人的相同項目請使用數量調整。"],
    ["INVALID_BOOKING_SLOT",400,"INVALID_BOOKING_SLOT","這段預約時間超出工作時間。"],
    ["INVALID_BOOKING_CONTACT",400,"INVALID_BOOKING_CONTACT","預約聯絡資料不完整。"],
    ["MEMBERSHIP_REQUIRED",403,"MEMBERSHIP_REQUIRED","請先加入會員並完成會員資料。"],
    ["MEMBER_DISABLED",403,"MEMBER_DISABLED","此會員目前已停用。"],
  ];
  for (const [needle, status, code, message] of rules) if (text.includes(needle)) return new ApiError(status, code, message);
  if (error?.code === "23P01" || error?.code === "23505") return new ApiError(409, "BOOKING_SLOT_TAKEN", "選擇的技師在這段時間已被預約。");
  return new ApiError(500, "DATABASE_ERROR", "資料庫暫時無法完成預約操作。");
}
function fail(origin: string | null, error: unknown) {
  const e = error instanceof ApiError ? error : mapDbError(error);
  return reply(origin, { ok: false, error: { code: e.code, message: e.message, details: e.details } }, e.status);
}
function db(): SupabaseClient {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function asText(value: unknown, max = 1000) { return String(value ?? "").trim().slice(0, max); }
function uuid(value: unknown, label: string) {
  const v = asText(value, 60);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) throw new ApiError(400, "INVALID_INPUT", `${label}格式不正確。`);
  return v;
}
function optionalUuid(value: unknown, label: string) {
  const v = asText(value, 60); return v ? uuid(v, label) : "";
}
function dateValue(value: unknown) {
  const v = asText(value, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError(400, "INVALID_DATE", "日期格式不正確。"); return v;
}
function timeValue(value: unknown) {
  const v = asText(value, 8); const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[2]) % 5 !== 0 || (v.length === 8 && !v.endsWith(":00"))) throw new ApiError(400, "INVALID_TIME", "時間必須以 5 分鐘為起始單位。");
  return `${m[1]}:${m[2]}`;
}
const toMinutes = (v: string) => { const [h, m] = v.slice(0, 5).split(":").map(Number); return h * 60 + m; };
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function taipeiDate() { const x: Record<string,string> = {}; new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Taipei", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach((p) => { if (p.type !== "literal") x[p.type] = p.value; }); return `${x.year}-${x.month}-${x.day}`; }
function taipeiMinutes() { const x: Record<string,string> = {}; new Intl.DateTimeFormat("en-GB", { timeZone:"Asia/Taipei", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(new Date()).forEach((p) => { if (p.type !== "literal") x[p.type] = p.value; }); return Number(x.hour || 0) * 60 + Number(x.minute || 0); }
function addDays(date: string, days: number) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function channelId(clientType: ClientType) {
  const value = env(clientType === "admin" ? "LINE_ADMIN_CHANNEL_ID" : "LINE_MEMBER_CHANNEL_ID") || (clientType === "admin" ? "2010791619" : "2010787602");
  if (!/^\d{5,30}$/.test(value)) throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 驗證設定尚未完成。"); return value;
}
async function verifyLine(idToken: string, clientType: ClientType): Promise<Identity> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: channelId(clientType),
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  }) as Identity;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function consumeRateLimit(s: SupabaseClient, i: Identity, action: string): Promise<void> {
  const { data, error } = await s.rpc("consume_api_rate_limit", {
    p_principal_hash: await sha256(i.lineUserId),
    p_is_write: WRITE_ACTIONS.has(action),
    p_cost: 1,
    p_read_limit: READ_LIMIT,
    p_write_limit: WRITE_LIMIT,
  });
  if (error) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "無法確認請求頻率限制。");
  if (!data) throw new ApiError(429, "RATE_LIMITED", "請求過於密集，請稍後再試。");
}

async function member(s: SupabaseClient, i: Identity) {
  const r = await s.from("members").select("*").eq("line_user_id", i.lineUserId).maybeSingle(); if (r.error) throw mapDbError(r.error);
  if (!r.data || r.data.membership_status !== "active") throw new ApiError(403, "MEMBERSHIP_REQUIRED", "請先加入會員。");
  if (r.data.status !== "active") throw new ApiError(403, "MEMBER_DISABLED", "會員目前已停用。");
  if (!(await hasCurrentTermsConsent(s, r.data.id))) throw new ApiError(403, "TERMS_RECONSENT_REQUIRED", "請先至會員卡同意新版條款。");
  return r.data;
}
async function admin(s: SupabaseClient, i: Identity) {
  return await requireActiveAdminContract({
    supabase: s,
    identity: i,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function audit(s: SupabaseClient, i: Identity, role: string, action: string, targetType: string, targetId: string, metadata: Json = {}) {
  const r = await s.from("booking_audit_events").insert({ actor_line_user_id:i.lineUserId, actor_role:role, action, target_type:targetType, target_id:targetId, result:"success", metadata });
  if (r.error) console.error("audit failed", r.error.message);
}
function techClient(row: any) { return { technicianId:row.id, name:row.name, isActive:Boolean(row.is_active), sortOrder:Number(row.sort_order || 0), updatedAt:row.updated_at }; }
function itemClient(row: any) { const q=Number(row.quantity||1), price=Number(row.unit_price_amount||0), mins=Number(row.unit_duration_minutes||0); return { serviceId:row.service_id, serviceTitle:row.service_title, unitDurationMinutes:mins, unitPriceAmount:price, quantity:q, subtotalMinutes:mins*q, subtotalAmount:price*q }; }

async function settings(s: SupabaseClient) {
  const r = await s.from("booking_settings").select("*").eq("id",1).single(); if (r.error) throw mapDbError(r.error); return r.data;
}
function assertBookingDateWindow(cfg: any, date: string) {
  const today=currentBusinessDate(taipeiDate(),taipeiMinutes(),cfg.work_start_time,cfg.work_end_time), earliest=addDays(today,Number(cfg.min_advance_days||0)), max=Number(cfg.max_advance_days||0), latest=max>0?addDays(today,max):"";
  if (date < earliest) throw new ApiError(409,"BOOKING_TOO_EARLY","尚未符合提前預約天數。");
  if (latest && date > latest) throw new ApiError(409,"BOOKING_TOO_FAR","此日期超過可預約範圍。");
}
async function activeTechs(s: SupabaseClient) {
  const r = await s.from("booking_technicians").select("*").eq("is_active",true).order("sort_order",{ascending:true}).order("created_at",{ascending:true}); if (r.error) throw mapDbError(r.error); return r.data || [];
}

async function isActiveBookingHoliday(s: SupabaseClient, date: string) {
  const r=await s.from("calendar_items").select("id,starts_on,ends_on").eq("item_type","holiday").eq("status","active").lte("starts_on",date);
  if (r.error) throw mapDbError(r.error);
  return (r.data||[]).some((row:any)=>String(row.starts_on||"")<=date && String(row.ends_on||row.starts_on||"")>=date);
}

async function groupData(s: SupabaseClient, bookingIds: string[]) {
  if (!bookingIds.length) return new Map<string,Json>();
  const [bookings, parts] = await Promise.all([
    s.from("bookings").select("id,technician_id,party_size,service_recipient_member_id,booking_technicians(name),recipient:members!bookings_service_recipient_member_id_fkey(member_code,display_name)").in("id",bookingIds),
    s.from("booking_participants").select("id,booking_id,position,technician_id,booking_technicians(name)").in("booking_id",bookingIds).order("position",{ascending:true}),
  ]);
  if (bookings.error) throw mapDbError(bookings.error); if (parts.error) throw mapDbError(parts.error);
  const partIds = (parts.data || []).map((p:any) => p.id); let itemRows:any[] = [];
  if (partIds.length) {
    const ir = await s.from("booking_participant_items").select("participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity").in("participant_id",partIds).order("created_at",{ascending:true});
    if (ir.error) throw mapDbError(ir.error); itemRows = ir.data || [];
  }
  const byPart = new Map<string,any[]>();
  for (const x of itemRows) { const a=byPart.get(x.participant_id)||[]; a.push(itemClient(x)); byPart.set(x.participant_id,a); }
  const byBookingParts = new Map<string,any[]>();
  for (const p of parts.data || []) {
    const a = byBookingParts.get(p.booking_id) || [];
    a.push({ position:Number(p.position), technicianId:p.technician_id || "", technicianName:(p.booking_technicians as any)?.name || "現場安排", items:byPart.get(p.id) || [] });
    byBookingParts.set(p.booking_id,a);
  }
  const out = new Map<string,Json>();
  for (const b of bookings.data || []) out.set(b.id, { serviceRecipientMemberCode:(b.recipient as any)?.member_code||"",serviceRecipientName:(b.recipient as any)?.display_name||"", technicianId:b.technician_id, technicianName:(b.booking_technicians as any)?.name || "", partySize:Number(b.party_size || 1), participants:byBookingParts.get(b.id) || [] });
  return out;
}

async function fullBooking(s: SupabaseClient, id: string) {
  const [br, ir, benefitResult] = await Promise.all([
    s.from("bookings").select("*, members!bookings_member_id_fkey(display_name,member_code), booking_technicians(name)").eq("id",id).single(),
    s.from("booking_items").select("booking_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity").eq("booking_id",id).order("created_at",{ascending:true}),
    s.from("booking_benefit_selections").select("benefit_kind,benefit_ref,title_snapshot,status,redeemed_at,selected_at,result").eq("booking_id",id).order("selected_at",{ascending:true}),
  ]);
  if (br.error) throw mapDbError(br.error);
  if (ir.error) throw mapDbError(ir.error);
  if (benefitResult.error) throw mapDbError(benefitResult.error);
  const items=(ir.data||[]).map(itemClient), benefits=(benefitResult.data||[]).filter((x:any)=>["points","event"].includes(String(x.benefit_kind||""))).map((x:any)=>({kind:x.benefit_kind,id:x.benefit_ref,title:x.title_snapshot||"可用權益",status:x.status||"pending",cancellationReason:x.result?.cancellationReason||"",redeemedAt:x.redeemed_at||null})), g=(await groupData(s,[id])).get(id)||{}, r=br.data;
  return { bookingId:r.id, requestId:r.request_id, serviceId:r.service_id, serviceTitle:items.map((x:any)=>x.serviceTitle).join(" + ")||"預約項目", items, benefits, totalDurationMinutes:Number(r.total_duration_minutes||30), totalAmount:items.reduce((sum:number,x:any)=>sum+Number(x.subtotalAmount||0),0), memberId:r.member_id, memberDisplayName:r.members?.display_name||"", memberCode:r.members?.member_code||"", bookingDate:r.booking_date, startTime:String(r.start_time||"").slice(0,5), endTime:String(r.end_time||"").slice(0,5), startAt:localTimestamp(r.start_at), endAt:localTimestamp(r.end_at), status:r.status, memberNote:r.member_note||"", adminNote:r.admin_note||"", completedAt:r.completed_at||null, confirmedAt:r.confirmed_at, rejectedAt:r.rejected_at, cancelledAt:r.cancelled_at, createdAt:r.created_at, updatedAt:r.updated_at, contactSource:r.contact_source||"member", contactSurname:r.contact_surname||"", contactSalutation:r.contact_salutation||"", contactPhone:r.contact_phone||"", ...g };
}

async function normalizeGroup(s: SupabaseClient, body: Json) {
  const cfg = await settings(s), raw = Array.isArray(body.participants) ? body.participants : [];
  if (raw.length < 1 || raw.length > Number(cfg.max_party_size || 1)) throw new ApiError(400,"INVALID_PARTY_SIZE","預約人數超出目前允許範圍。");
  const primaryId = optionalUuid(cfg.primary_technician_id,"主要技師");
  if (cfg.require_primary_technician !== false && !primaryId) throw new ApiError(409,"BOOKING_PRIMARY_TECHNICIAN_MISSING","管理端尚未設定主要技師。");
  const active = await activeTechs(s), techMap = new Map(active.map((x:any)=>[String(x.id),x]));
  if (cfg.require_primary_technician !== false && !techMap.has(primaryId)) throw new ApiError(409,"BOOKING_PRIMARY_TECHNICIAN_DISABLED","主要技師目前未開放預約。");

  const serviceIds = new Set<string>(), selectedTechs = new Set<string>(), normalized:Json[] = [];
  let primarySelected = false;
  for (const p of raw) {
    if (!p || !Array.isArray(p.items) || p.items.length < 1 || p.items.length > 20) throw new ApiError(400,"INVALID_BOOKING_ITEMS","每一位預約人都至少要選擇一個項目。");
    const techId = optionalUuid(p.technicianId,"技師");
    if (techId) {
      if (!techMap.has(techId)) throw new ApiError(409,"BOOKING_TECHNICIAN_DISABLED","選擇的技師目前未開放預約。");
      if (selectedTechs.has(techId)) throw new ApiError(400,"DUPLICATE_PARTICIPANT_TECHNICIAN","同一位技師不能同時安排給兩位預約人。");
      selectedTechs.add(techId); if (techId === primaryId) primarySelected = true;
    }
    const items:Json[] = [], seen = new Set<string>();
    for (const x of p.items) {
      const id = uuid(x.serviceId,"預約項目"), q=Number(x.quantity??1);
      if (id === STORE_SERVICE_ID) throw new ApiError(400,"INVALID_BOOKING_ITEMS","店內服務由系統自動加入。");
      if (!Number.isInteger(q) || q < 1 || q > 2) throw new ApiError(400,"INVALID_BOOKING_QUANTITY","項目數量不正確。");
      if (seen.has(id)) throw new ApiError(400,"DUPLICATE_BOOKING_SERVICE","同一位預約人的相同項目不可重複列出。");
      seen.add(id); serviceIds.add(id); items.push({serviceId:id,quantity:q});
    }
    normalized.push({ technicianId:techId || null, items });
  }
  if (cfg.require_primary_technician !== false && !primarySelected) throw new ApiError(400,"BOOKING_PRIMARY_TECHNICIAN_REQUIRED","每筆預約至少要有一位選擇主要技師。");

  const sr = await s.from("booking_services").select("*").in("id",[...serviceIds,STORE_SERVICE_ID]); if (sr.error) throw mapDbError(sr.error);
  const sm = new Map((sr.data||[]).map((x:any)=>[String(x.id),x])), store=sm.get(STORE_SERVICE_ID);
  if (!store || !store.is_active) throw new ApiError(409,"BOOKING_SERVICE_DISABLED","店內服務目前未開放。");
  let maxParticipantDuration=0, amount=Number(store.price_amount||0); const assignments:Json[]=[];
  for (const p of normalized) {
    let participantDuration=0, hasAddOn=false, hasRegular=false;
    for (const x of p.items) {
      const svc=sm.get(x.serviceId); if (!svc) throw new ApiError(404,"BOOKING_SERVICE_NOT_FOUND","找不到其中一個預約項目。");
      if (!svc.is_active) throw new ApiError(409,"BOOKING_SERVICE_DISABLED","其中一個預約項目目前未開放。");
      if (Boolean(svc.requires_companion_service)) hasAddOn=true; else hasRegular=true;
      const mins=Number(svc.duration_minutes||0)*x.quantity, price=Number(svc.price_amount||0)*x.quantity;
      participantDuration += mins; amount += price;
    }
    if (hasAddOn && !hasRegular) throw new ApiError(400,"BOOKING_ADD_ON_REQUIRES_COMPANION","加購項目不能單獨預約，請至少再選擇一個一般項目。");
    maxParticipantDuration = Math.max(maxParticipantDuration, participantDuration);
    if (p.technicianId) assignments.push({ technicianId:p.technicianId, durationMinutes:participantDuration });
  }
  const duration=maxParticipantDuration+Number(store.duration_minutes||0);
  return { cfg, primaryId, participants:normalized, duration, amount, assignments };
}

async function memberBootstrap(s: SupabaseClient, m: any) {
  const cfg=await settings(s), techs=await activeTechs(s), br=await s.from("bookings").select("id").eq("member_id",m.id).order("created_at",{ascending:false}).limit(50);
  if (br.error) throw mapDbError(br.error); const ids=(br.data||[]).map((x:any)=>x.id), groups=await groupData(s,ids);
  return { settings:{ maxPartySize:Number(cfg.max_party_size||1), requirePrimaryTechnician:cfg.require_primary_technician !== false,primaryTechnicianId:cfg.primary_technician_id||"", updatedAt:cfg.updated_at }, technicians:techs.map(techClient), bookingGroups:Object.fromEntries([...groups.entries()]) };
}

async function slots(s: SupabaseClient, m: any, body: Json) {
  const g=await normalizeGroup(s,body), date=dateValue(body.bookingDate), cfg=g.cfg, today=currentBusinessDate(taipeiDate(),taipeiMinutes(),cfg.work_start_time,cfg.work_end_time), earliest=addDays(today,Number(cfg.min_advance_days||0)), max=Number(cfg.max_advance_days||0), latest=max>0?addDays(today,max):"";
  if (date < earliest || (latest && date > latest)) return { settings:{maxPartySize:Number(cfg.max_party_size||1),requirePrimaryTechnician:cfg.require_primary_technician !== false,primaryTechnicianId:g.primaryId,maxAdvanceDays:max}, totalDurationMinutes:g.duration, totalAmount:g.amount, slots:[] };
  if (await isActiveBookingHoliday(s,date)) return { settings:{maxPartySize:Number(cfg.max_party_size||1),requirePrimaryTechnician:cfg.require_primary_technician !== false,primaryTechnicianId:g.primaryId,maxAdvanceDays:max}, totalDurationMinutes:g.duration, totalAmount:g.amount, holidayBlocked:true, slots:[] };
  let excluded="";
  if (body.bookingId) {
    excluded=uuid(body.bookingId,"預約"); const r=await s.from("bookings").select("id,status").eq("id",excluded).eq("member_id",m.id).maybeSingle();
    if (r.error) throw mapDbError(r.error); if (!r.data || !["pending","confirmed"].includes(r.data.status)) throw new ApiError(409,"BOOKING_NOT_EDITABLE","找不到可修改的預約。");
  }
  const legacyTechnicianIds=[...new Set([...g.assignments.map((x:any)=>x.technicianId),...(cfg.require_primary_technician !== false && g.primaryId ? [g.primaryId] : [])])];
  const primaryRows=legacyTechnicianIds.length ? await s.from("bookings").select("id,start_at,end_at").gte("booking_date",addDays(date,-1)).lte("booking_date",addDays(date,1)).in("technician_id",legacyTechnicianIds).eq("party_size",1).in("status",["pending","confirmed"]) : {data:[],error:null};
  if (primaryRows.error) throw mapDbError(primaryRows.error);
  const primaryOccupied=(primaryRows.data||[]).filter((x:any)=>x.id!==excluded).map(occupiedRange);

  const techIds=[...new Set(g.assignments.map((x:any)=>x.technicianId))]; let reservationRows:any[]=[];
  if (techIds.length) {
    const rr=await s.from("booking_participant_reservations").select("booking_id,technician_id,start_at,end_at").gte("booking_date",addDays(date,-1)).lte("booking_date",addDays(date,1)).eq("is_active",true).in("technician_id",techIds);
    if (rr.error) throw mapDbError(rr.error); reservationRows=(rr.data||[]).filter((x:any)=>x.booking_id!==excluded);
  }
  const occupiedByTech=new Map<string,any[]>();
  for (const row of reservationRows) { const a=occupiedByTech.get(row.technician_id)||[]; a.push(occupiedRange(row)); occupiedByTech.set(row.technician_id,a); }

  const workStart=toMinutes(cfg.work_start_time), workEnd=workWindow(cfg.work_start_time,cfg.work_end_time).end, interval=Number(cfg.slot_interval_minutes||SLOT_INTERVAL), out:Json[]=[];
  for (let cursor=workStart; cursor+g.duration<=workEnd; cursor+=interval) {
    const groupEnd=cursor+g.duration;
    const candidate=localRange(date,cursor,g.duration);
    const mainOverlap=primaryOccupied.some((x:any)=>candidate.start<x.end && candidate.end>x.start);
    const assignmentOverlap=g.assignments.some((a:any)=>(occupiedByTech.get(a.technicianId)||[]).some((x:any)=>candidate.start<x.end && localRange(date,cursor,Number(a.durationMinutes||0)).end>x.start));
    const passed=slotHasPassed(date,cursor);
    out.push({startTime:clockTime(cursor),endTime:clockTime(groupEnd),startAt:timeOnBusinessDate(date,cursor),endAt:timeOnBusinessDate(date,groupEnd),available:!mainOverlap&&!assignmentOverlap&&!passed});
  }
  return { settings:{maxPartySize:Number(cfg.max_party_size||1),requirePrimaryTechnician:cfg.require_primary_technician !== false,primaryTechnicianId:g.primaryId,maxAdvanceDays:max}, totalDurationMinutes:g.duration, totalAmount:g.amount, slots:out };
}

function contact(body: Json) { const source=asText(body.contactSource,20)||"member"; return { source, surname:asText(body.contactSurname,40)||null, salutation:asText(body.contactSalutation,10)||null, phone:asText(body.contactPhone,20)||null }; }
function normalizeBookingBenefits(value: unknown): Json[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400,"INVALID_BOOKING_BENEFITS","選用優惠資料格式不正確。");
  const seen = new Set<string>();
  return value.map((raw:any) => {
    const kind=asText(raw?.kind,20).toLowerCase(), id=asText(raw?.id,160), key=`${kind}:${id}`;
    if (!["points","event"].includes(kind) || !id || seen.has(key)) throw new ApiError(400,"INVALID_BOOKING_BENEFITS","選用優惠資料格式不正確。");
    seen.add(key);
    return {kind,id};
  });
}
async function validateBookingBenefitSelectionLimit(s: SupabaseClient, value: unknown): Promise<Json[]> {
  const benefits=normalizeBookingBenefits(value);
  const eventCount=benefits.filter((item:any)=>item.kind==="event").length;
  const pointCount=benefits.filter((item:any)=>item.kind==="points").length;
  if (!eventCount && !pointCount) return benefits;
  const [eventSetting,pointSetting]=await Promise.all([
    eventCount
      ? s.from("event_ticket_settings").select("max_tickets_per_day").eq("id",1).maybeSingle()
      : Promise.resolve({data:null,error:null}),
    pointCount
      ? s.from("point_card_settings").select("max_tickets_per_redemption").eq("id",1).maybeSingle()
      : Promise.resolve({data:null,error:null}),
  ]);
  if (eventSetting.error) throw mapDbError(eventSetting.error);
  if (pointSetting.error) throw mapDbError(pointSetting.error);
  const rawEvent=Number(eventSetting.data?.max_tickets_per_day??1);
  const maxEvent=Number.isInteger(rawEvent)&&rawEvent>=0&&rawEvent<=50?rawEvent:1;
  const rawPoint=Number(pointSetting.data?.max_tickets_per_redemption??1);
  const maxPoint=Number.isInteger(rawPoint)&&rawPoint>=0&&rawPoint<=50?rawPoint:1;
  if (maxEvent>0&&eventCount>maxEvent) throw new ApiError(409,"EVENT_TICKET_SELECTION_LIMIT_EXCEEDED",`活動票券每筆預約最多可選 ${maxEvent} 張。`);
  if (maxPoint>0&&pointCount>maxPoint) throw new ApiError(409,"POINT_TICKET_SELECTION_LIMIT_EXCEEDED",`集點卡票券每筆預約最多可選 ${maxPoint} 張。`);
  return benefits;
}
async function createBooking(s: SupabaseClient, i: Identity, m: any, body: Json) {
  const g=await normalizeGroup(s,body), c=contact(body), requestId=asText(body.requestId,100), bookingDate=dateValue(body.bookingDate);
  assertBookingDateWindow(g.cfg,bookingDate);
  if (!/^BOOK-[A-Za-z0-9-]{8,95}$/.test(requestId)) throw new ApiError(400,"INVALID_REQUEST_ID","操作識別碼格式不正確。");
  const benefits=await validateBookingBenefitSelectionLimit(s,body.benefits);
  const friendCode=asText(body.serviceRecipientMemberCode,40);
  const r=await s.rpc(friendCode ? "create_friend_booking_request" : "create_group_booking_with_benefits_request_v2", { ...(friendCode?{p_actor:i.lineUserId,p_friend_code:friendCode}:{p_member_id:m.id}), p_request_id:requestId, p_booking_date:bookingDate, p_start_time:`${timeValue(body.startTime)}:00`, p_participants:g.participants, p_member_note:asText(body.memberNote,500), p_contact_source:c.source, p_contact_surname:c.surname, p_contact_salutation:c.salutation, p_contact_phone:c.phone, p_benefits:benefits });
  if (r.error) throw mapDbError(r.error); const row=Array.isArray(r.data)?r.data[0]:r.data, booking=await fullBooking(s,row.id);
  await audit(s,i,"member","BOOKING_GROUP_REQUESTED","booking",row.id,{partySize:g.participants.length,requirePrimaryTechnician:g.cfg.require_primary_technician !== false,primaryTechnicianId:g.primaryId,participantTechnicians:g.participants.map((p:any)=>p.technicianId||null)});
  return {booking};
}
async function updateBooking(s: SupabaseClient, i: Identity, m: any, body: Json) {
  const g=await normalizeGroup(s,body), c=contact(body), bookingId=uuid(body.bookingId,"預約"), expected=asText(body.expectedUpdatedAt,80), bookingDate=dateValue(body.bookingDate);
  assertBookingDateWindow(g.cfg,bookingDate);
  if (!expected || !Number.isFinite(Date.parse(expected))) throw new ApiError(400,"INVALID_INPUT","缺少預約版本，請重新整理。");
  const existing=await s.from("bookings").select("service_recipient_member_id").eq("id",bookingId).eq("member_id",m.id).maybeSingle();
  if(existing.error)throw mapDbError(existing.error);
  if(existing.data?.service_recipient_member_id && g.participants.length!==1)throw new ApiError(400,"FRIEND_SINGLE_RECIPIENT_REQUIRED","代好友預約只支援單人服務。");
  const benefits=await validateBookingBenefitSelectionLimit(s,body.benefits);
  const r=await s.rpc("update_group_booking_with_benefits_request_v2", { p_booking_id:bookingId, p_expected_updated_at:expected, p_actor:i.lineUserId, p_request_id:asText(body.requestId,100), p_member_id:m.id, p_booking_date:bookingDate, p_start_time:`${timeValue(body.startTime)}:00`, p_participants:g.participants, p_member_note:asText(body.memberNote,500), p_contact_source:c.source, p_contact_surname:c.surname, p_contact_salutation:c.salutation, p_contact_phone:c.phone, p_benefits:benefits });
  if (r.error) throw mapDbError(r.error); return {booking:await fullBooking(s,bookingId)};
}

async function adminBootstrap(s: SupabaseClient) {
  const cfg=await settings(s), tr=await s.from("booking_technicians").select("*").order("sort_order",{ascending:true}).order("created_at",{ascending:true}); if (tr.error) throw mapDbError(tr.error);
  return { settings:{maxPartySize:Number(cfg.max_party_size||1),requirePrimaryTechnician:cfg.require_primary_technician !== false,primaryTechnicianId:cfg.primary_technician_id||"",updatedAt:cfg.updated_at}, technicians:(tr.data||[]).map(techClient) };
}
async function saveSettings(s: SupabaseClient, i: Identity, body: Json) {
  const max=Number(body.maxPartySize); if (!Number.isInteger(max)||max<1||max>10) throw new ApiError(400,"INVALID_PARTY_SIZE","預約人數上限必須介於 1–10 人。");
  const expected=asText(body.expectedUpdatedAt,80), primary=optionalUuid(body.primaryTechnicianId,"主要技師");
  const current = await settings(s);
  const required = body.requirePrimaryTechnician === undefined ? current.require_primary_technician !== false : body.requirePrimaryTechnician;
  if (typeof required !== "boolean") throw new ApiError(400,"INVALID_INPUT","主要技師必填設定必須是布林值。");
  if (required && !primary) throw new ApiError(400,"BOOKING_PRIMARY_TECHNICIAN_MISSING","請選擇主要技師。");
  if (primary) {
    const tr=await s.from("booking_technicians").select("id,is_active").eq("id",primary).maybeSingle(); if (tr.error) throw mapDbError(tr.error);
    if (!tr.data) throw new ApiError(404,"BOOKING_TECHNICIAN_NOT_FOUND","找不到選擇的主要技師。");
    if (!tr.data.is_active) throw new ApiError(409,"BOOKING_TECHNICIAN_DISABLED","主要技師必須是開放狀態。");
  }
  let q=s.from("booking_settings").update({max_party_size:max,primary_technician_id:primary||null,require_primary_technician:required,updated_by:i.lineUserId}).eq("id",1); if (expected) q=q.eq("updated_at",expected);
  const r=await q.select("*").maybeSingle(); if (r.error) throw mapDbError(r.error); if (!r.data) throw new ApiError(409,"CONFLICT","預約設定已被其他操作更新，請重新整理。");
  await audit(s,i,"admin","BOOKING_RESOURCE_SETTINGS_UPDATED","booking_settings","1",{maxPartySize:max,requirePrimaryTechnician:required,primaryTechnicianId:primary||null});
  return {settings:{maxPartySize:max,requirePrimaryTechnician:required,primaryTechnicianId:primary||"",updatedAt:r.data.updated_at}};
}
async function saveTechnician(s: SupabaseClient, i: Identity, body: Json) {
  const name=asText(body.name,80); if (!name) throw new ApiError(400,"INVALID_INPUT","請輸入技師名稱。");
  const isActive=body.isActive!==false, sortOrder=Number(body.sortOrder||0); if (!Number.isInteger(sortOrder)||sortOrder<0||sortOrder>9999) throw new ApiError(400,"INVALID_INPUT","技師排序必須介於 0–9999。");
  const id=asText(body.technicianId,60), expected=asText(body.expectedUpdatedAt,80);
  if (id && !isActive) { const cfg=await settings(s); if (String(cfg.primary_technician_id||"")===id) throw new ApiError(409,"BOOKING_PRIMARY_TECHNICIAN_DISABLED","主要技師不可停用，請先變更主要技師。"); }
  let saved:any;
  if (id) {
    uuid(id,"技師"); let q=s.from("booking_technicians").update({name,is_active:isActive,sort_order:sortOrder,updated_at:new Date().toISOString()}).eq("id",id); if (expected) q=q.eq("updated_at",expected);
    const r=await q.select("*").maybeSingle(); if (r.error) throw mapDbError(r.error); if (!r.data) throw new ApiError(409,"CONFLICT","技師資料已被其他操作更新，請重新整理。"); saved=r.data;
  } else {
    const r=await s.from("booking_technicians").insert({name,is_active:isActive,sort_order:sortOrder,created_by:i.lineUserId}).select("*").single();
    if (r.error) { if (r.error.code==="23505") throw new ApiError(409,"DUPLICATE_TECHNICIAN","技師名稱不可重複。"); throw mapDbError(r.error); } saved=r.data;
  }
  await audit(s,i,"admin",id?"BOOKING_TECHNICIAN_UPDATED":"BOOKING_TECHNICIAN_CREATED","booking_technician",saved.id,{name,isActive,sortOrder}); return {technician:techClient(saved)};
}

async function route(s: SupabaseClient, i: Identity, clientType: ClientType, action: string, body: Json) {
  if (clientType === "member") {
    const m=await member(s,i);
    if (action==="user.booking.group.bootstrap") return memberBootstrap(s,m);
    if (action==="user.booking.group.slots") return slots(s,m,body);
    if (action==="user.booking.group.create") return createBooking(s,i,m,body);
    if (action==="user.booking.group.update") return updateBooking(s,i,m,body);
    throw new ApiError(404,"ACTION_NOT_FOUND","不支援的多人預約操作。");
  }
  await admin(s,i);
  if (action==="admin.booking.resources.bootstrap") return adminBootstrap(s);
  if (action==="admin.booking.resources.settings.save") return saveSettings(s,i,body);
  if (action==="admin.booking.resources.technician.save") return saveTechnician(s,i,body);
  throw new ApiError(404,"ACTION_NOT_FOUND","不支援的預約資源管理操作。");
}

serveBusiness('booking-group-api',async (req: Request) => {
  const origin=req.headers.get("Origin");
  if (req.method==="OPTIONS") return new Response(null,{status:204,headers:cors(origin)});
  if (req.method!=="POST") return reply(origin,{ok:false,error:{code:"METHOD_NOT_ALLOWED",message:"只支援 POST。"}},405);
  if (origin && !allowedOrigins().has(origin)) return reply(origin,{ok:false,error:{code:"ORIGIN_DENIED",message:"不允許的來源。"}},403);
  try {
    const body=await readJsonObject(req,MAX_REQUEST_BYTES,ApiError), action=asText(body.action,100), clientType=asText(body.clientType,20) as ClientType;
    if (!action || !["member","admin"].includes(clientType)) throw new ApiError(400,"INVALID_INPUT","請求格式不正確。");
    if (clientType==="member" && !action.startsWith("user.booking.group.")) throw new ApiError(403,"CLIENT_ACTION_MISMATCH","操作端與功能不相符。");
    if (clientType==="admin" && !action.startsWith("admin.booking.resources.")) throw new ApiError(403,"CLIENT_ACTION_MISMATCH","操作端與功能不相符。");
    const supabase=db();
    let identity: Identity;
    if (clientType === "member") {
      try {
        const testIdentity = await resolveUserTestIdentity(supabase, asText(body.testSessionToken,200));
        identity = testIdentity
          ? { lineUserId:testIdentity.lineUserId, displayName:testIdentity.displayName }
          : await verifyLine(asText(body.idToken,5000),clientType);
      } catch (error) {
        if (error instanceof TestModeAuthError) throw new ApiError(error.status,error.code,error.message);
        throw error;
      }
    } else {
      identity = await verifyLine(asText(body.idToken,5000),clientType);
    }
    await consumeRateLimit(supabase,identity,action);
    const data=await route(supabase,identity,clientType,action,body);
    return reply(origin,{ok:true,data});
  } catch (error) { return fail(origin,error); }
});
