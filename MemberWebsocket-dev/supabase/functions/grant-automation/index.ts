import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { buildLineFlexNotice } from "../_shared/line-flex.ts";
import { buildLatestAvailableOffersSection } from "../_shared/latest-available-offers.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

type Json = Record<string, unknown>;
type NotificationMode = "none" | "immediate" | "scheduled";

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

const TIER_LABELS: Record<string,string> = { general:"一般會員",silver:"銀級會員",gold:"金級會員",platinum:"白金會員" };
const MAX_REQUEST_BYTES = 40_000;
const WRITE_LIMIT = 30;
const READ_LIMIT = 90;

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function asText(value: unknown, max = 1000): string { return String(value ?? "").trim().slice(0,max); }
function requireText(value: unknown, label: string, max = 100): string {
  const text = asText(value,max);
  if (!text) throw new ApiError(400,"INVALID_INPUT",label + "不可空白。");
  return text;
}
function dbClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503,"SUPABASE_CONFIG_MISSING","Supabase server 設定尚未完成。");
  return createClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false } });
}
function allowedOrigins(): Set<string> {
  return new Set((env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io").split(",").map((v) => v.trim()).filter(Boolean));
}
function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins().has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control":"no-store",
    "Vary":"Origin",
  };
}
function response(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload),{ status,headers:{ ...corsHeaders(origin),"Content-Type":"application/json; charset=utf-8" } });
}
function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = String((error as { message?: string })?.message || "");
  const rules: Array<[string,number,string,string]> = [
    ["CONFLICT",409,"CONFLICT","資料已被其他操作更新，請重新整理後再試。"],
    ["MEMBER_NOT_FOUND",404,"MEMBER_NOT_FOUND","找不到指定會員。"],
    ["POINT_CARD_NOT_AVAILABLE",409,"POINT_CARD_NOT_AVAILABLE","這張集點卡目前無法使用。"],
    ["INVALID_REQUEST_ID",400,"INVALID_REQUEST_ID","操作識別碼格式不正確。"],
    ["INVALID_POINT_AMOUNT",400,"INVALID_POINT_AMOUNT","點數必須是 1–100 的整數。"],
    ["INVALID_SERVICE_MINUTES",400,"INVALID_SERVICE_MINUTES","服務時間必須是 1–1440 分鐘。"],
    ["INVALID_EVENT_BONUS_POINTS",400,"INVALID_EVENT_BONUS_POINTS","活動加贈點數必須是 1–100 的整數。"],
    ["DUPLICATE_POINT_CARD",400,"DUPLICATE_POINT_CARD","同一次發放不可重複選擇同一張集點卡。"],
    ["CALENDAR_ITEM_NOT_FOUND",404,"CALENDAR_ITEM_NOT_FOUND","找不到日曆項目。"],
  ];
  for (const [needle,status,code,userMessage] of rules) if (message.includes(needle)) return new ApiError(status,code,userMessage);
  return new ApiError(500,"DATABASE_ERROR","資料庫暫時無法完成操作。");
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2,"0")).join("");
}
async function verifyAdminIdToken(idToken: string): Promise<{ lineUserId:string;displayName:string }> {
  return await verifyLineIdTokenContract({
    idToken,
    expectedChannelId: env("LINE_ADMIN_CHANNEL_ID") || "2010791619",
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function authorizeAdmin(supabase: SupabaseClient, identity: { lineUserId:string;displayName:string }): Promise<void> {
  await requireActiveAdminContract({
    supabase,
    identity,
    createError: (status, code, message, details = null) => new ApiError(status, code, message, details),
  });
}

async function consumeRateLimit(supabase: SupabaseClient, principal: string, isWrite: boolean): Promise<void> {
  const result = await supabase.rpc("consume_api_rate_limit",{
    p_principal_hash:await sha256(principal),p_is_write:isWrite,p_cost:1,p_read_limit:READ_LIMIT,p_write_limit:WRITE_LIMIT,
  });
  if (result.error) throw new ApiError(503,"RATE_LIMIT_UNAVAILABLE","無法確認請求頻率限制。");
  if (!result.data) throw new ApiError(429,"RATE_LIMITED","請求過於密集，請稍後再試。");
}
function formatTaipeiDateTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-TW",{ timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false }).format(value);
}
function resolveTier(settings: any[], minutes: number): any {
  const ordered = [...settings].sort((a,b) => Number(a.required_service_minutes || 0) - Number(b.required_service_minutes || 0));
  let selected = ordered[0] || { tier_key:"general",tier_label:"一般會員",style_key:"forest" };
  for (const row of ordered) if (minutes >= Number(row.required_service_minutes || 0)) selected = row;
  return selected;
}
async function lineToken(supabase: SupabaseClient): Promise<string> {
  const result = await supabase.rpc("get_line_messaging_token");
  if (result.error) return "";
  return asText(result.data,10000);
}
async function auditLine(supabase: SupabaseClient, actor: string, target: string, requestId: string, result: string, detail: Json): Promise<void> {
  await supabase.from("audit_logs").insert({
    audit_id:"AUD-" + crypto.randomUUID().replaceAll("-","") ,actor_line_user_id:actor,actor_role:"system",
    action:"line.push.grant",target_type:"member",target_id:target,result,detail:{ requestId,...detail },
  });
}
async function pushLine(supabase: SupabaseClient, actor: string, lineUserId: string, requestId: string, message: string): Promise<Json> {
  const token = await lineToken(supabase);
  if (!token) return { status:"failed",message:"發放已成功，但 LINE Messaging API 尚未設定。" };
  let lineResponse: Response;
  try {
    const flexMessage = buildLineFlexNotice(message,{
      title:"會員權益通知",
      eyebrow:"MEMBER BENEFITS",
    });
    lineResponse = await fetch("https://api.line.me/v2/bot/message/push",{
      method:"POST",
      headers:{ "Authorization":"Bearer " + token,"Content-Type":"application/json","X-Line-Retry-Key":crypto.randomUUID() },
      body:JSON.stringify({ to:lineUserId,messages:[flexMessage] }),
    });
  } catch {
    await auditLine(supabase,actor,lineUserId,requestId,"failed",{ reason:"network_error" });
    return { status:"failed",message:"發放已成功，但 LINE 推播連線失敗。" };
  }
  const lineRequestId = lineResponse.headers.get("x-line-request-id") || "";
  await auditLine(supabase,actor,lineUserId,requestId,lineResponse.ok ? "success" : "failed",{ httpStatus:lineResponse.status,lineRequestId });
  if (!lineResponse.ok) return { status:"failed",message:"發放已成功，但 LINE 推播未送達。" };
  return { status:"sent",message:"LINE 訊息已傳送。",lineRequestId };
}
async function availableTicketsSection(supabase: SupabaseClient, memberId: string, tierKey: string): Promise<string> {
  return await buildLatestAvailableOffersSection(supabase,memberId,tierKey);
}
async function buildGrantMessage(supabase: SupabaseClient, member: any, tier: any, totalMinutes: number, grantResult: any, presetMessage: string, serviceMinutes: number): Promise<string> {
  const sections: string[] = [];
  const greeting = (asText(member.display_name,120) || "會員") + "，您好：";
  if (presetMessage) sections.push(presetMessage);
  const pointDetails = Array.isArray(grantResult.pointDetails) ? grantResult.pointDetails : [];
  if (pointDetails.length) {
    const lines = pointDetails.map((row:any) => {
      const base = Number(row.baseAmount || 0);
      const bonus = Number(row.bonusAmount || 0);
      const effective = Number(row.effectiveAmount || base + bonus);
      return "・" + String(row.cardTitle || "集點卡") + " +" + effective + " 點" + (bonus > 0 ? "（基本 +" + base + "、活動加贈 +" + bonus + "）" : "");
    });
    sections.push("【本次點數】\n" + lines.join("\n"));
  }
  if (serviceMinutes > 0) sections.push("【本次服務時間】\n・增加 " + serviceMinutes + " 分鐘");
  const bonusEvents = Array.isArray(grantResult.bonusEvents) ? grantResult.bonusEvents : [];
  if (bonusEvents.length && pointDetails.length) {
    const lines = bonusEvents.map((row:any) => "・" + String(row.title || "活動") + "：每張本次發放的集點卡 +" + Number(row.bonusPoints || 0) + " 點");
    sections.push("【活動加贈】\n" + lines.join("\n"));
  }
  sections.push("【目前會員狀態】\n・累積服務時間：" + totalMinutes + " 分鐘\n・會員等級：" + String(tier.tier_label || TIER_LABELS[tier.tier_key] || "一般會員"));
  const ticketSection = await availableTicketsSection(supabase,member.id,String(tier.tier_key || "general"));
  if (ticketSection) sections.push(ticketSection);
  return (greeting + "\n\n" + sections.filter(Boolean).join("\n\n")).slice(0,5000);
}
function notificationMode(value: unknown): NotificationMode {
  const mode = asText(value,20) || "immediate";
  if (!["none","immediate","scheduled"].includes(mode)) throw new ApiError(400,"INVALID_NOTIFICATION_MODE","請選擇訊息傳送方式。");
  return mode as NotificationMode;
}
async function handleGrant(supabase: SupabaseClient, identity: { lineUserId:string;displayName:string }, body: Json): Promise<Json> {
  const lineUserId = requireText(body.lineUserId,"會員識別",120);
  const req = requireText(body.requestId,"操作識別碼",100);
  const requestedMode = notificationMode(body.notificationMode);

  // Test accounts use the exact same grant path as real members; only LINE side effects are disabled.
  const memberResult = await supabase.from("members").select("*").eq("line_user_id",lineUserId).single();
  if (memberResult.error) throw mapError(memberResult.error);
  const member:any = memberResult.data;
  const mode: NotificationMode = member.is_test_account === true ? "none" : requestedMode;

  const messagePresetId = asText(body.messagePresetId,120);
  let presetMessage = "";
  if (mode !== "none" && messagePresetId) {
    const preset = await supabase.from("grant_message_presets").select("message,status").eq("preset_id",messagePresetId).eq("status","active").maybeSingle();
    if (preset.error) throw mapError(preset.error);
    if (!preset.data) throw new ApiError(400,"MESSAGE_PRESET_NOT_AVAILABLE","選擇的預設訊息目前無法使用。");
    presetMessage = asText(preset.data.message,1000);
  }
  const points = Array.isArray(body.points) ? body.points : [];
  const serviceMinutes = Number((body.serviceTime && typeof body.serviceTime === "object" ? (body.serviceTime as Json).minutes : 0) || 0);
  let scheduledAt: Date | null = null;
  if (mode === "scheduled") {
    scheduledAt = new Date(requireText(body.scheduledAt,"預約傳送時間",80));
    if (!Number.isFinite(scheduledAt.getTime())) throw new ApiError(400,"INVALID_SCHEDULED_AT","預約傳送時間格式不正確。");
    const now = Date.now();
    if (scheduledAt.getTime() <= now + 30_000) throw new ApiError(400,"INVALID_SCHEDULED_AT","預約傳送時間必須晚於現在。" );
    if (scheduledAt.getTime() > now + 366 * 24 * 60 * 60 * 1000) throw new ApiError(400,"INVALID_SCHEDULED_AT","預約傳送時間最遠可設定一年內。" );
  }

  const grant = await supabase.rpc("grant_member_benefits_with_event_bonus",{
    p_actor_line_user_id:identity.lineUserId,p_member_line_user_id:lineUserId,p_request_id:req,p_points:points,p_service_minutes:serviceMinutes || 0,p_note:"",
  });
  if (grant.error) throw mapError(grant.error);
  const grantResult:any = grant.data && typeof grant.data === "object" ? grant.data : {};

  const service = await supabase.rpc("member_service_minute_totals",{p_member_ids:[member.id]});
  if (service.error) throw mapError(service.error);
  const totalMinutes = Number(service.data?.[0]?.total_minutes || 0);
  const tiers = await supabase.from("membership_tier_settings").select("*").order("required_service_minutes",{ ascending:true });
  if (tiers.error) throw mapError(tiers.error);
  const tier:any = resolveTier(tiers.data || [],totalMinutes);

  let notification: Json = { status:"skipped",message:"已依設定不傳送 LINE 訊息。" };
  if (mode !== "none") {
    const message = await buildGrantMessage(supabase,member,tier,totalMinutes,grantResult,presetMessage,serviceMinutes);
    if (mode === "immediate") {
      notification = grantResult.applied
        ? await pushLine(supabase,identity.lineUserId,lineUserId,req,message)
        : { status:"skipped",message:"此操作已處理，未重複發送 LINE 訊息。" };
    } else if (scheduledAt) {
      const existing = await supabase.from("scheduled_grant_messages").select("schedule_id,status,scheduled_for").eq("request_id",req).maybeSingle();
      if (existing.error) throw mapError(existing.error);
      if (!existing.data) {
        const inserted = await supabase.from("scheduled_grant_messages").insert({
          schedule_id:"SGM-" + crypto.randomUUID().replaceAll("-","") ,request_id:req,member_id:member.id,line_user_id:lineUserId,
          scheduled_for:scheduledAt.toISOString(),message_text:message,status:"pending",created_by:identity.lineUserId,
        }).select("schedule_id,status,scheduled_for").single();
        if (inserted.error) throw mapError(inserted.error);
      }
      notification = { status:"scheduled",message:"LINE 訊息已預約於 " + formatTaipeiDateTime(scheduledAt) + " 傳送。",scheduledAt:scheduledAt.toISOString() };
    }
  }

  const bonusTotal = Number(grantResult.bonusTotalPerCard || 0);
  if (bonusTotal > 0 && notification.status === "sent") {
    notification = { ...notification,status:"info",message:"活動加贈 +" + bonusTotal + " 點／每張本次集點卡已自動套用；LINE 訊息已傳送。" };
  } else if (bonusTotal > 0 && notification.status === "skipped" && mode === "none") {
    notification = { ...notification,message:"活動加贈 +" + bonusTotal + " 點／每張本次集點卡已自動套用；已依設定不傳送 LINE 訊息。" };
  } else if (bonusTotal > 0 && notification.status === "scheduled") {
    notification = { ...notification,message:"活動加贈 +" + bonusTotal + " 點／每張本次集點卡已自動套用；" + String(notification.message || "") };
  }

  return {
    member:{ lineUserId,displayName:member.display_name,memberCode:member.member_code,status:member.status,joinedAt:member.joined_at || member.created_at,serviceMinutesTotal:totalMinutes,tierKey:tier.tier_key,tier:tier.tier_label,tierStyleKey:tier.style_key,updatedAt:member.updated_at },
    notification,
    bonus:{ totalPerCard:bonusTotal,events:Array.isArray(grantResult.bonusEvents) ? grantResult.bonusEvents : [] },
  };
}
function calendarClient(row: any): Json {
  return {
    calendarItemId:row.calendar_item_id,title:row.title,itemType:row.item_type,description:row.description || "",startsOn:row.starts_on,endsOn:row.ends_on || "",
    status:row.status,accent:row.accent,allowedTierKeys:Array.isArray(row.allowed_tier_keys) ? row.allowed_tier_keys : [],linkLabel:row.link_label || "",linkUrl:row.link_url || "",
    bonusPointsEnabled:Boolean(row.item_type === "event" && row.bonus_points_enabled),bonusPoints:row.item_type === "event" && row.bonus_points_enabled ? Number(row.bonus_points || 0) : 0,
    createdAt:row.created_at,updatedAt:row.updated_at,
  };
}
async function handleCalendarList(supabase: SupabaseClient): Promise<Json> {
  const rows = await supabase.from("calendar_items").select("*").order("starts_on",{ ascending:true }).order("created_at",{ ascending:true });
  if (rows.error) throw mapError(rows.error);
  return { calendarItems:(rows.data || []).map(calendarClient) };
}
async function handleCalendarSave(supabase: SupabaseClient, identity: { lineUserId:string }, body: Json): Promise<Json> {
  const item = body.calendarItem && typeof body.calendarItem === "object" ? body.calendarItem as Json : {};
  const result = await supabase.rpc("save_calendar_item_with_bonus",{
    p_actor_line_user_id:identity.lineUserId,p_calendar_item:item,p_expected_updated_at:asText(body.expectedUpdatedAt,100),
  });
  if (result.error) throw mapError(result.error);
  const id = String((result.data as any[])?.[0]?.calendarItemId || "");
  const row = await supabase.from("calendar_items").select("*").eq("calendar_item_id",id).single();
  if (row.error) throw mapError(row.error);
  return { calendarItem:calendarClient(row.data) };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null,{ status:204,headers:corsHeaders(origin) });
  if (request.method !== "POST") return response(origin,{ ok:false,status:405,error:{ code:"METHOD_NOT_ALLOWED",message:"只支援 POST。" } },405);
  try {
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);
    const action = requireText(body.action,"API action",100);
    if (!["admin.member-grants.add","admin.calendar-items.save","admin.calendar-items.list"].includes(action)) throw new ApiError(404,"ACTION_NOT_FOUND","不支援的 API action。");
    const identity = await verifyAdminIdToken(requireText(body.idToken,"LINE ID token",5000));
    const supabase = dbClient();
    await authorizeAdmin(supabase,identity);
    const isWrite = action !== "admin.calendar-items.list";
    await consumeRateLimit(supabase,identity.lineUserId,isWrite);
    const data = action === "admin.member-grants.add"
      ? await handleGrant(supabase,identity,body)
      : action === "admin.calendar-items.save"
        ? await handleCalendarSave(supabase,identity,body)
        : await handleCalendarList(supabase);
    return response(origin,{ ok:true,status:200,data },200);
  } catch (error) {
    const apiError = mapError(error);
    return response(origin,{ ok:false,status:apiError.status,error:{ code:apiError.code,message:apiError.message,details:apiError.details } },apiError.status);
  }
});
