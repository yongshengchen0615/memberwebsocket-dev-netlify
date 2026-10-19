import { businessEnv, serveBusiness } from '../_shared/business-runtime.ts';
import { bookingTicketUsageError } from "../_shared/booking-ticket-usage.ts";
import { readJsonObject } from "../_shared/request-body.ts";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { resolveUserTestIdentity, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import { hasCurrentTermsConsent } from "../_shared/membership-terms.ts";
import { loadBookingBenefits } from "../_shared/booking-benefits.ts";
import { createClient, SupabaseClient } from '../_shared/business-runtime.ts';

type Json = Record<string, unknown>;
type Identity = { lineUserId: string; displayName: string };

const BUCKET = "booking-receipts";
const MAX_REQUEST_BYTES = 24_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const READ_LIMIT = 90;
const WRITE_LIMIT = 20;
const ALLOWED_MIME = new Set(["image/jpeg","image/png","image/webp","image/heic","image/heif"]);

class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message); this.status=status; this.code=code; this.details=details;
  }
}

function env(name: string): string { return (businessEnv(name) || "").trim(); }
function asText(value: unknown, max=1000): string { return String(value ?? "").trim().slice(0,max); }
function allowedOrigins(): Set<string> {
  return new Set([(env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io"), "https://develop--memberwebsocket-dev-netlify.netlify.app"].join(",").split(",").map(v=>v.trim()).filter(Boolean));
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
function response(origin: string | null,payload:unknown,status=200):Response {
  return new Response(JSON.stringify(payload),{status,headers:{...corsHeaders(origin),"Content-Type":"application/json; charset=utf-8"}});
}
function dbClient(): SupabaseClient {
  const url=env("SUPABASE_URL"); const key=env("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key) throw new ApiError(503,"SUPABASE_CONFIG_MISSING","Supabase server 設定尚未完成。");
  return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}
async function sha256Hex(value: string):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
async function fileSha256Hex(bytes:ArrayBuffer):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
async function consumeRateLimit(supabase:SupabaseClient,identity:Identity,write:boolean):Promise<void>{
  const {data,error}=await supabase.rpc("consume_api_rate_limit",{
    p_principal_hash:await sha256Hex(identity.lineUserId),p_is_write:write,p_cost:1,
    p_read_limit:READ_LIMIT,p_write_limit:WRITE_LIMIT
  });
  if(error) throw new ApiError(503,"RATE_LIMIT_UNAVAILABLE","無法確認請求頻率限制。");
  if(!data) throw new ApiError(429,"RATE_LIMITED","請求過於密集，請稍後再試。");
}
async function resolveUserIdentity(supabase:SupabaseClient,body:Json):Promise<Identity>{
  try{
    const testIdentity=await resolveUserTestIdentity(supabase,asText(body.testSessionToken,200));
    if(testIdentity){
      if(testIdentity.surface!=="booking") throw new ApiError(403,"TEST_SESSION_SURFACE_MISMATCH","測試登入與目前功能不相符。");
      return {lineUserId:testIdentity.lineUserId,displayName:testIdentity.displayName};
    }
    return await verifyLineIdTokenContract({
      idToken:asText(body.idToken,10_000),
      expectedChannelId:env("LINE_BOOKING_CHANNEL_ID")||"2010787602",
      createError:(status,code,message,details=null)=>new ApiError(status,code,message,details),
    }) as Identity;
  }catch(error){
    if(error instanceof TestModeAuthError) throw new ApiError(error.status,error.code,error.message);
    throw error;
  }
}
async function resolveAdminIdentity(body:Json):Promise<Identity>{
  return await verifyLineIdTokenContract({
    idToken:asText(body.idToken,10_000),
    expectedChannelId:env("LINE_ADMIN_CHANNEL_ID")||"2010791619",
    createError:(status,code,message,details=null)=>new ApiError(status,code,message,details),
  }) as Identity;
}
async function requireMember(supabase:SupabaseClient,identity:Identity):Promise<any>{
  const result=await supabase.from("members")
    .select("id,line_user_id,display_name,member_code,status,membership_status")
    .eq("line_user_id",identity.lineUserId).maybeSingle();
  if(result.error) throw new ApiError(500,"DATABASE_ERROR","會員資料暫時無法讀取。");
  const member=result.data;
  if(!member||member.status!=="active"||member.membership_status!=="active") throw new ApiError(403,"MEMBERSHIP_REQUIRED","請先完成會員申請。");
  if(!await hasCurrentTermsConsent(supabase,member.id)) throw new ApiError(403,"TERMS_RECONSENT_REQUIRED","請先同意目前有效的會員條款。");
  return member;
}
function dbError(error:unknown):ApiError{
  const ticketError=bookingTicketUsageError(error,(status,code,message)=>new ApiError(status,code,message));
  if(ticketError) return ticketError as ApiError;
  const raw=error as {message?:string;details?:string;code?:string};
  if(raw?.code==="22P02"||raw?.code==="22007"||raw?.code==="22008") return new ApiError(400,"INVALID_INPUT","日期、時間或服務項目格式不正確。");
  if(raw?.code==="23P01") return new ApiError(409,"BOOKING_SLOT_TAKEN","此時間已有預約，請優先連結該會員已有預約，或核對服務日期與時間。");
  const message=String(raw?.message||"")+" "+String(raw?.details||"");
  const rules:Array<[string,number,string,string]>=[
    ["SNAPSHOT_LOCATION_REQUIRED",409,"SNAPSHOT_LOCATION_REQUIRED","快照前須取得定位，請允許定位後重試。"],
    ["SNAPSHOT_LOCATION_INVALID",409,"SNAPSHOT_LOCATION_INVALID","定位已失效、精準度不足或格式不正確，請重新定位後重試。"],
    ["SNAPSHOT_LOCATION_NOT_CONFIGURED",409,"SNAPSHOT_LOCATION_NOT_CONFIGURED","管理端尚未設定快照可使用地點，請聯絡管理員。"],
    ["SNAPSHOT_LOCATION_OUT_OF_RANGE",409,"SNAPSHOT_LOCATION_OUT_OF_RANGE","目前定位不在管理端指定的快照地點範圍內，請到指定地點後重新定位。"],
    ["ADMIN_REQUIRED",403,"ADMIN_REQUIRED","管理端帳號尚未授權。"],
    ["MEMBERSHIP_REQUIRED",403,"MEMBERSHIP_REQUIRED","會員目前無法使用此功能。"],
    ["INVALID_BOOKING_ITEMS",400,"INVALID_BOOKING_ITEMS","請選擇有效服務項目與分鐘數。"],
    ["INVALID_BOOKING_DURATION",400,"INVALID_BOOKING_DURATION","服務總時間必須少於 24 小時。"],
    ["bookings_start_boundary_check",400,"INVALID_BOOKING_SLOT","請填寫有效的服務日期與開始時間。"],
    ["INVALID_BOOKING_SLOT",400,"INVALID_BOOKING_SLOT","請填寫有效的服務日期與開始時間。"],
    ["INVALID_BOOKING_BENEFITS",400,"INVALID_BOOKING_BENEFITS","預約票券資料格式不正確。"],
    ["BOOKING_BENEFIT_NOT_AVAILABLE",409,"BOOKING_BENEFIT_NOT_AVAILABLE","其中一張票券目前不可使用，請重新整理後再審核。"],
    ["BOOKING_BENEFIT_LOCATION_REQUIRED",409,"BOOKING_BENEFIT_LOCATION_REQUIRED","其中一張票券未通過快照 GPS 地點驗證，請回到指定地點重新定位。"],
    ["LOCATION_OUT_OF_RANGE",409,"LOCATION_OUT_OF_RANGE","您目前不在票券可使用地點範圍，請抵達指定地點後重新定位。"],
    ["LOCATION_INVALID",409,"LOCATION_INVALID","GPS 精度不足或定位已過期，請重新定位。"],
    ["LOCATION_REQUIRED",409,"LOCATION_REQUIRED","此票券需要有效 GPS 定位，請重新定位。"],
    ["BOOKING_BENEFIT_SERVICE_REQUIRED",409,"BOOKING_BENEFIT_SERVICE_REQUIRED","其中一張票券不符合本次實際服務項目，請重新核對票券。"],
    ["POINT_TICKET_INSUFFICIENT_POINTS",409,"POINT_TICKET_INSUFFICIENT_POINTS","會員目前可用點數不足，請取消部分集點卡票券。"],
    ["EVENT_TICKET_DAILY_LIMIT_REACHED",409,"EVENT_TICKET_DAILY_LIMIT_REACHED","會員今日活動票券使用張數已達上限。"],
    ["TICKET_BATCH_LIMIT_EXCEEDED",409,"TICKET_BATCH_LIMIT_EXCEEDED","本次選用的集點卡票券超過單次核銷上限。"],
    ["INSUFFICIENT_POINTS",409,"INSUFFICIENT_POINTS","會員目前點數不足，無法核銷所選集點卡票券。"],
    ["TICKET_NOT_AVAILABLE",409,"BOOKING_BENEFIT_NOT_AVAILABLE","其中一張集點卡票券已不可使用。"],
    ["CLAIM_NOT_AVAILABLE",409,"BOOKING_BENEFIT_NOT_AVAILABLE","其中一張活動票券已不可使用。"],
    ["BOOKING_SERVICE_NOT_FOUND",400,"BOOKING_SERVICE_NOT_FOUND","服務項目已停用，請重新選擇。"],
    ["BOOKING_PRIMARY_TECHNICIAN_MISSING",409,"BOOKING_PRIMARY_TECHNICIAN_MISSING","請先設定有效的主要技師。"],
    ["BOOKING_NOT_FOUND",404,"BOOKING_NOT_FOUND","找不到這筆預約。"],
    ["BOOKING_NOT_OWNED",403,"BOOKING_NOT_OWNED","不可操作其他會員的預約。"],
    ["INVALID_BOOKING_TRANSITION",409,"INVALID_BOOKING_TRANSITION","此預約目前不能完成。"],
    ["BOOKING_CANCELLATION_PENDING",409,"BOOKING_CANCELLATION_PENDING","此預約仍有取消申請待處理。"],
    ["BOOKING_NOT_FINISHED_YET",409,"BOOKING_NOT_FINISHED_YET","預約服務時間尚未結束。"],
    ["BOOKING_ALREADY_COMPLETED_WITH_RECEIPT",409,"BOOKING_ALREADY_COMPLETED_WITH_RECEIPT","此預約已完成並綁定收據。"],
    ["RECEIPT_UPLOAD_IN_PROGRESS",409,"RECEIPT_UPLOAD_IN_PROGRESS","已有收據正在上傳，請稍後再試。"],
    ["RECEIPT_AWAITING_REVIEW",409,"RECEIPT_AWAITING_REVIEW","收據已送出，請等待管理端確認。"],
    ["RECEIPT_AWAITING_REVIEW_REQUIRED",409,"RECEIPT_AWAITING_REVIEW_REQUIRED","尚無待確認的收據。"],
    ["RECEIPT_INVALID_MIME",400,"RECEIPT_INVALID_MIME","請拍攝或選擇支援的圖片格式。"],
    ["RECEIPT_FILE_TOO_LARGE",413,"RECEIPT_FILE_TOO_LARGE","收據圖片不可超過 5 MB。"],
    ["RECEIPT_INVALID_PATH",400,"RECEIPT_INVALID_PATH","收據上傳位置無效。"],
    ["RECEIPT_NOT_PENDING",409,"RECEIPT_NOT_PENDING","這次收據上傳已被取代，請重新拍攝。"],
    ["RECEIPT_NOT_FOUND",404,"RECEIPT_NOT_FOUND","找不到這筆收據上傳。"],
    ["RECEIPT_NOT_OWNED",403,"RECEIPT_NOT_OWNED","不可操作其他會員的收據。"],
    ["RECEIPT_MIME_MISMATCH",400,"RECEIPT_MIME_MISMATCH","收據圖片格式與上傳資料不一致。"],
    ["RECEIPT_SIZE_MISMATCH",400,"RECEIPT_SIZE_MISMATCH","收據圖片大小與上傳資料不一致。"],
    ["RECEIPT_INVALID_HASH",400,"RECEIPT_INVALID_HASH","收據圖片驗證失敗。"],
    ["BOOKING_CONFLICT",409,"BOOKING_CONFLICT","預約資料已變更，請重新整理後再試。"],
    ["BOOKING_COMPLETION_ALREADY_SETTLED",409,"BOOKING_COMPLETION_ALREADY_SETTLED","此預約已完成結算。"],
    ["REQUEST_ID_CONFLICT",409,"REQUEST_ID_CONFLICT","同一操作識別不可套用不同內容。"],
    ["INVALID_REQUEST_ID",400,"INVALID_REQUEST_ID","操作識別格式不正確。"],
  ];
  for(const [needle,status,code,userMessage] of rules) if(message.includes(needle)) return new ApiError(status,code,userMessage);
  console.error(JSON.stringify({event:"booking_receipt_db_error",code:raw?.code||"",message:String(raw?.message||"").slice(0,300)}));
  return new ApiError(500,"DATABASE_ERROR","目前無法完成收據與預約操作。");
}
function extensionFor(mime:string):string{
  if(mime==="image/jpeg") return "jpg";
  if(mime==="image/png") return "png";
  if(mime==="image/webp") return "webp";
  if(mime==="image/heic") return "heic";
  return "heif";
}
function sniffMime(bytes:Uint8Array):string{
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) return "image/jpeg";
  if(bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47&&bytes[4]===0x0d&&bytes[5]===0x0a&&bytes[6]===0x1a&&bytes[7]===0x0a) return "image/png";
  const ascii=(start:number,length:number)=>String.fromCharCode(...bytes.slice(start,start+length));
  if(bytes.length>=12&&ascii(0,4)==="RIFF"&&ascii(8,4)==="WEBP") return "image/webp";
  if(bytes.length>=12&&ascii(4,4)==="ftyp"){
    const brand=ascii(8,4).toLowerCase();
    if(["heic","heix","hevc","hevx"].includes(brand)) return "image/heic";
    if(["mif1","msf1","heif"].includes(brand)) return "image/heif";
  }
  return "";
}
async function drainCleanupQueue(supabase:SupabaseClient):Promise<void>{
  try{
    const rows=await supabase.from("booking_receipt_cleanup_queue").select("id,object_path,attempts").order("id",{ascending:true}).limit(20);
    if(rows.error||!rows.data?.length) return;
    for(const row of rows.data){
      const removed=await supabase.storage.from(BUCKET).remove([String(row.object_path)]);
      if(!removed.error){
        await supabase.from("booking_receipt_cleanup_queue").delete().eq("id",row.id);
      }else{
        await supabase.from("booking_receipt_cleanup_queue")
          .update({attempts:Number(row.attempts||0)+1,last_error:String(removed.error.message||"").slice(0,300)})
          .eq("id",row.id);
      }
    }
  }catch{ /* best-effort compensation; request path stays independent */ }
}
function localTaipeiNowMs():number{
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`);
}
async function memberList(supabase:SupabaseClient,member:any,body:Json={}):Promise<Json>{
  const result=await supabase.from("bookings")
    .select("id,status,updated_at,end_at,booking_date,end_time,starts_next_day,cancellation_requested_at,cancellation_reviewed_at,booking_receipts!booking_receipts_booking_id_fkey(receipt_id,status,created_at,bound_at,failure_reason)")
    .eq("member_id",member.id)
    .in("status",["confirmed","completed"])
    .order("booking_date",{ascending:false})
    .limit(80);
  if(result.error) throw new ApiError(500,"DATABASE_ERROR","預約收據資料暫時無法讀取。");
  const now=localTaipeiNowMs();
  const bookings=(result.data||[]).map((row:any)=>{
    const receipt=Array.isArray(row.booking_receipts)?row.booking_receipts.filter((item:any)=>["bound","awaiting_review","pending_upload"].includes(item.status)).sort((a:any,b:any)=>{
      const priority=(status:string)=>status==="bound"?0:status==="awaiting_review"?1:2;
      return priority(a.status)-priority(b.status)||String(b.created_at).localeCompare(String(a.created_at));
    })[0]||null:null;
    const rawEndAt=String(row.end_at||"").trim().replace(" ","T");
    const normalizedEndAt=rawEndAt && !/(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(rawEndAt) ? rawEndAt+"+08:00" : rawEndAt;
    const endMs=normalizedEndAt?Date.parse(normalizedEndAt):Date.parse(`${row.booking_date}T${String(row.end_time||"00:00").slice(0,8)}+08:00`)+(row.starts_next_day?86400000:0);
    const cancellationPending=Boolean(row.cancellation_requested_at&&!row.cancellation_reviewed_at);
    return {
      bookingId:String(row.id),
      status:String(row.status||""),
      updatedAt:row.updated_at,
      canSubmitReceipt:row.status==="confirmed"&&!cancellationPending,
      canComplete:row.status==="confirmed"&&!cancellationPending&&Number.isFinite(endMs)&&now>=endMs,
      receipt:receipt?{
        receiptId:String(receipt.receipt_id||""),
        status:String(receipt.status||""),
        createdAt:receipt.created_at,
        boundAt:receipt.bound_at,
        failureReason:String(receipt.failure_reason||""),
      }:null,
    };
  });
  const submissions=await supabase.from("booking_receipts")
    .select("receipt_id,booking_id,status,created_at,updated_at,failure_reason,requested_benefits,requested_booking_id,booking_completion_settlements:bookings!booking_receipts_booking_id_fkey(booking_completion_settlements(service_minutes,reward_details),booking_completion_adjustments(after_settlement,created_at,id))")
    .eq("member_id",member.id).eq("submission_mode","accessible").in("status",["awaiting_review","bound","failed"])
    .order("updated_at",{ascending:false}).limit(10);
  if(submissions.error) throw new ApiError(500,"DATABASE_ERROR","收據登記狀態暫時無法讀取。");
  const targetId=String(body.receiptId || '').trim();
  if(targetId){
    if(!/^BR-[a-f0-9]{32}$/i.test(targetId))throw new ApiError(400,"INVALID_RECEIPT_ID","快照識別格式不正確。");
    const target=await supabase.from("booking_receipts").select("receipt_id,booking_id,status,created_at,updated_at,failure_reason,requested_benefits,requested_booking_id,booking_completion_settlements:bookings!booking_receipts_booking_id_fkey(booking_completion_settlements(service_minutes,reward_details),booking_completion_adjustments(after_settlement,created_at,id))").eq("receipt_id",targetId).eq("member_id",member.id).eq("submission_mode","accessible").in("status",["awaiting_review","bound","failed"]).maybeSingle();
    if(target.error)throw new ApiError(500,"DATABASE_ERROR","快照明細暫時無法讀取。");
    if(!target.data)throw new ApiError(404,"RECEIPT_NOT_FOUND","找不到可查看的快照明細。");
    if(!(submissions.data || []).some((r:any)=>r.receipt_id===targetId))submissions.data!.unshift(target.data);
  }
  const settings = await supabase.from("booking_settings").select("snapshot_location_required,snapshot_locations").eq("id",1).single();
  if(settings.error) throw new ApiError(503,"SNAPSHOT_POLICY_UNAVAILABLE","目前無法確認快照定位政策，請稍後重試。");
  return {snapshotLocationRequired:settings.data.snapshot_location_required===true,
    snapshotLocations:settings.data.snapshot_location_required===true && Array.isArray(settings.data.snapshot_locations)
      ? settings.data.snapshot_locations : [],bookings,submissions:(submissions.data||[]).map((r:any)=>({receiptId:r.receipt_id,bookingId:r.booking_id,
    status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,
    dismissed:r.failure_reason==="admin-dismissed",cancelled:r.failure_reason==="member-cancelled",requestedBenefits:r.requested_benefits||[],requestedBookingId:r.requested_booking_id||"",
    settlement:effectiveSettlement(r.booking_completion_settlements)}))};
}
async function prepare(supabase:SupabaseClient,identity:Identity,member:any,body:Json):Promise<Json>{
  const bookingId=asText(body.bookingId,80);
  const requestId=asText(body.requestId,120);
  const mime=asText(body.mimeType,80).toLowerCase();
  const size=Number(body.sizeBytes);
  const accessible=body.accessible===true;
  if(!accessible&&!/^[0-9a-f-]{36}$/i.test(bookingId)) throw new ApiError(400,"INVALID_BOOKING_ID","預約識別格式不正確。");
  if(!ALLOWED_MIME.has(mime)) throw new ApiError(400,"RECEIPT_INVALID_MIME","請拍攝或選擇支援的圖片格式。");
  if(!Number.isSafeInteger(size)||size<1||size>MAX_FILE_BYTES) throw new ApiError(413,"RECEIPT_FILE_TOO_LARGE","收據圖片不可超過 5 MB。");

  const objectPath=`${member.id}/${accessible?"accessible":bookingId}/${crypto.randomUUID()}.${extensionFor(mime)}`;
  // Snapshot intent is never an advance reservation: a caller-supplied
  // requestedBookingId must not invoke the regular confirmed-booking gate.
  // Admin review may still link the receipt to a booking or create a
  // retrospective booking after validating actual services.
  const result=await supabase.rpc(accessible?"prepare_snapshot_receipt_v2":"prepare_booking_receipt_request",{
    ...(accessible?{p_location:body.location??null,p_benefits:normalizeAccessibleBenefits(body.benefits),p_booking_id:null}:{p_booking_id:bookingId}),p_member_id:member.id,p_request_id:requestId,
    p_object_path:objectPath,p_mime_type:mime,p_size_bytes:size
  });
  if(result.error) throw dbError(result.error);
  const prepared=(result.data||{}) as Json;
  if(prepared.status!=="pending_upload") {
    return {receiptId:prepared.receiptId,status:prepared.status,alreadyPrepared:true};
  }
  const path=asText(prepared.objectPath,500);
  const signed=await supabase.storage.from(BUCKET).createSignedUploadUrl(path,{upsert:false});
  if(signed.error||!signed.data?.token) {
    await supabase.rpc("fail_booking_receipt_request",{p_receipt_id:prepared.receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,p_reason:"signed-upload-url-failed"});
    throw new ApiError(503,"RECEIPT_UPLOAD_UNAVAILABLE","目前無法建立安全上傳連結。");
  }
  return {
    receiptId:prepared.receiptId,
    objectPath:path,
    uploadToken:signed.data.token,
    uploadExpiresInSeconds:7200,
    alreadyPrepared:Boolean(prepared.alreadyPrepared),
  };
}
async function finalize(supabase:SupabaseClient,identity:Identity,member:any,body:Json):Promise<Json>{
  const receiptId=asText(body.receiptId,80);
  const expectedUpdatedAt=asText(body.expectedUpdatedAt,100);
  const receiptResult=await supabase.from("booking_receipts")
    .select("receipt_id,booking_id,member_id,object_path,declared_mime_type,declared_size_bytes,status,submission_mode")
    .eq("receipt_id",receiptId).maybeSingle();
  if(receiptResult.error) throw new ApiError(500,"DATABASE_ERROR","目前無法確認收據上傳。");
  const receipt=receiptResult.data;
  if(!receipt) throw new ApiError(404,"RECEIPT_NOT_FOUND","找不到這筆收據上傳。");
  if(String(receipt.member_id)!==String(member.id)) throw new ApiError(403,"RECEIPT_NOT_OWNED","不可操作其他會員的收據。");
  const accessible=receipt.submission_mode==="accessible";
  if(receipt.status==="bound"||receipt.status==="awaiting_review"){
    const repeat=await supabase.rpc(accessible?"finalize_snapshot_receipt_v2":"finalize_booking_receipt_request",{
      p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,
      ...(accessible?{p_location:body.location??null}:{p_expected_booking_updated_at:expectedUpdatedAt}),p_actual_mime_type:receipt.declared_mime_type,
      p_actual_size_bytes:receipt.declared_size_bytes,p_sha256_hex:"0".repeat(64)
    });
    if(repeat.error) throw dbError(repeat.error);
    return (repeat.data||{}) as Json;
  }

  const downloaded=await supabase.storage.from(BUCKET).download(String(receipt.object_path));
  if(downloaded.error||!downloaded.data){
    await supabase.rpc("fail_booking_receipt_request",{p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,p_reason:"uploaded-object-missing"});
    throw new ApiError(409,"RECEIPT_UPLOAD_MISSING","找不到已上傳的收據圖片，請重新拍攝。");
  }
  if(downloaded.data.size<1||downloaded.data.size>MAX_FILE_BYTES){
    await supabase.rpc("fail_booking_receipt_request",{p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,p_reason:"actual-size-invalid"});
    await drainCleanupQueue(supabase);
    throw new ApiError(413,"RECEIPT_FILE_TOO_LARGE","收據圖片大小不符合限制。");
  }
  const bytes=await downloaded.data.arrayBuffer();
  const actualMime=sniffMime(new Uint8Array(bytes));
  const declared=String(receipt.declared_mime_type||"").toLowerCase();
  const heifPair=new Set([declared,actualMime]);
  const mimeMatches=declared===actualMime||(heifPair.has("image/heic")&&heifPair.has("image/heif"));
  if(!actualMime||!mimeMatches){
    await supabase.rpc("fail_booking_receipt_request",{p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,p_reason:"magic-mime-mismatch"});
    await drainCleanupQueue(supabase);
    throw new ApiError(400,"RECEIPT_MIME_MISMATCH","收據圖片實際格式與上傳資料不一致。");
  }
  if(downloaded.data.size!==Number(receipt.declared_size_bytes)){
    await supabase.rpc("fail_booking_receipt_request",{p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,p_reason:"actual-size-mismatch"});
    await drainCleanupQueue(supabase);
    throw new ApiError(400,"RECEIPT_SIZE_MISMATCH","收據圖片大小與上傳資料不一致。");
  }
  const hash=await fileSha256Hex(bytes);
  const finalized=await supabase.rpc(accessible?"finalize_snapshot_receipt_v2":"finalize_booking_receipt_request",{
    p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,
    ...(accessible?{p_location:body.location??null}:{p_expected_booking_updated_at:expectedUpdatedAt}),p_actual_mime_type:declared,
    p_actual_size_bytes:downloaded.data.size,p_sha256_hex:hash
  });
  if(finalized.error){
    await supabase.rpc("fail_booking_receipt_request",{p_receipt_id:receiptId,p_member_id:member.id,p_actor_line_user_id:identity.lineUserId,p_reason:"receipt-finalize-failed"});
    await drainCleanupQueue(supabase);
    throw dbError(finalized.error);
  }
  return (finalized.data||{}) as Json;
}
function effectiveSettlement(booking:any):any {
  if (Array.isArray(booking)) booking=booking[0];
  const original=Array.isArray(booking?.booking_completion_settlements)?booking.booking_completion_settlements[0]:booking?.booking_completion_settlements;
  const latest=(booking?.booking_completion_adjustments||[]).slice().sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at))||String(b.id).localeCompare(String(a.id)))[0];
  if (!latest) return original||null;
  return {...original,service_minutes:latest.after_settlement?.serviceMinutes||0,reward_details:latest.after_settlement?.rewards||[],corrected_at:latest.created_at};
}
async function adminList(supabase:SupabaseClient):Promise<Json>{
  const result=await supabase.from("booking_receipts")
    .select("receipt_id,booking_id,status,created_at,updated_at,bound_at,actual_mime_type,actual_size_bytes")
    .in("status",["awaiting_review","bound"])
    .order("updated_at",{ascending:false})
    .limit(200);
  if(result.error) throw new ApiError(500,"DATABASE_ERROR","收據快照暫時無法讀取。");

  const accessible=await supabase.from("booking_receipts")
    .select(`
      receipt_id,booking_id,status,failure_reason,requested_benefits,requested_booking_id,created_at,updated_at,bound_at,
      members(display_name,member_code),
      bookings!booking_receipts_booking_id_fkey(
        id,booking_date,start_time,status,total_duration_minutes,completed_at,
        booking_items(service_id,service_title,unit_duration_minutes,quantity,service_type),
        booking_completion_settlements(service_minutes,reward_details,created_at),
        booking_completion_adjustments(after_settlement,created_at,id),
        booking_benefit_selections(benefit_kind,title_snapshot,status,redeemed_at,result)
      )
    `)
    .eq("submission_mode","accessible")
    .in("status",["awaiting_review","bound","failed"])
    .order("updated_at",{ascending:false})
    .limit(200);
  if(accessible.error) throw new ApiError(500,"DATABASE_ERROR","快照審核紀錄暫時無法讀取。");

  const accessibleRecords=(accessible.data||[]).map((row:any)=>{
    const booking=Array.isArray(row.bookings)?row.bookings[0]||null:row.bookings||null;
    const settlements=Array.isArray(booking?.booking_completion_settlements)
      ? booking.booking_completion_settlements
      : booking?.booking_completion_settlements ? [booking.booking_completion_settlements] : [];
    const settlement=effectiveSettlement(booking)||settlements[0]||null;
    const rewards=Array.isArray(settlement?.reward_details)?settlement.reward_details:[];
    const points=rewards.reduce((sum:number,reward:any)=>sum+Math.max(0,Number(reward?.points||0)),0);
    const services=(Array.isArray(booking?.booking_items)?booking.booking_items:[])
      .filter((item:any)=>String(item?.service_id||"")!=="00000000-0000-4000-8000-000000000010")
      .map((item:any)=>({
        serviceId:String(item?.service_id||""),
        title:String(item?.service_title||"服務項目"),
        minutes:Math.max(0,Number(item?.unit_duration_minutes||0)),
        quantity:Math.max(1,Number(item?.quantity||1)),
        serviceType:String(item?.service_type||""),
      }));
    const benefits=(Array.isArray(booking?.booking_benefit_selections)?booking.booking_benefit_selections:[])
      .filter((item:any)=>["points","event"].includes(String(item?.benefit_kind||"")))
      .map((item:any)=>({
        kind:String(item?.benefit_kind||""),
        title:String(item?.title_snapshot||"預約票券"),
        status:String(item?.status||""),
        cancellationReason:String(item?.result?.cancellationReason||""),
        redeemedAt:item?.redeemed_at||null,
      }));
    const status=String(row.status||"");
    const dismissed=status==="failed"&&String(row.failure_reason||"")==="admin-dismissed";
    return {
      receiptId:String(row.receipt_id||""),
      requestedBenefits:row.requested_benefits||[],requestedBookingId:row.requested_booking_id||"",
      bookingId:String(row.booking_id||""),
      status,
      reviewStatus:status==="awaiting_review"?"pending":status==="bound"?"completed":dismissed?"dismissed":"failed",
      failureReason:String(row.failure_reason||""),
      createdAt:row.created_at,
      updatedAt:row.updated_at,
      completedAt:row.bound_at||booking?.completed_at||settlement?.created_at||null,
      memberName:row.members?.display_name||"會員",
      memberCode:row.members?.member_code||"",
      bookingDate:booking?.booking_date||null,
      startTime:booking?.start_time?String(booking.start_time).slice(0,5):"",
      bookingStatus:String(booking?.status||""),
      totalDurationMinutes:Math.max(0,Number(booking?.total_duration_minutes||0)),
      serviceMinutes:Math.max(0,Number(settlement?.service_minutes||0)),
      points,
      services,
      benefits,
    };
  });

  const submissions=accessibleRecords
    .filter((row:any)=>row.reviewStatus==="pending")
    .map((row:any)=>({
      receiptId:row.receiptId,
      updatedAt:row.updatedAt,
      createdAt:row.createdAt,
      memberName:row.memberName,
      memberCode:row.memberCode,requestedBenefits:row.requestedBenefits,requestedBookingId:row.requestedBookingId,
    }));

  return {
    submissions,
    accessibleRecords,
    accessibleCounts:{
      pending:accessibleRecords.filter((row:any)=>row.reviewStatus==="pending").length,
      completed:accessibleRecords.filter((row:any)=>row.reviewStatus==="completed").length,
      all:accessibleRecords.length,
    },
    receipts:(result.data||[]).map((row:any)=>({
      receiptId:String(row.receipt_id||""),bookingId:String(row.booking_id||""),status:String(row.status||""),
      boundAt:row.bound_at,mimeType:String(row.actual_mime_type||""),sizeBytes:Number(row.actual_size_bytes||0)
    }))
  };
}
async function adminUrl(supabase:SupabaseClient,body:Json):Promise<Json>{
  const bookingId=asText(body.bookingId,80);
  const receiptId=asText(body.receiptId,80);
  if(!bookingId&&receiptId) {
    const receipt=await supabase.from("booking_receipts").select("object_path,receipt_id,booking_id,status")
      .eq("receipt_id",receiptId)
      .eq("submission_mode","accessible")
      .in("status",["awaiting_review","bound"])
      .maybeSingle();
    if(receipt.error) throw new ApiError(500,"DATABASE_ERROR","收據快照暫時無法讀取。");
    if(!receipt.data) throw new ApiError(404,"RECEIPT_NOT_FOUND","找不到可查看的快照收據快照。");
    const signed=await supabase.storage.from(BUCKET).createSignedUrl(receipt.data.object_path,120);
    if(signed.error||!signed.data?.signedUrl) throw new ApiError(503,"RECEIPT_VIEW_UNAVAILABLE","目前無法建立安全檢視連結。");
    return {
      receiptId:receipt.data.receipt_id,
      bookingId:String(receipt.data.booking_id||""),
      status:String(receipt.data.status||""),
      signedUrl:signed.data.signedUrl,
      expiresInSeconds:120
    };
  }
  const result=await supabase.from("booking_receipts").select("receipt_id,object_path,status,created_at,bound_at")
    .eq("booking_id",bookingId).in("status",["awaiting_review","bound"])
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(result.error) throw new ApiError(500,"DATABASE_ERROR","收據快照暫時無法讀取。");
  if(!result.data) throw new ApiError(404,"RECEIPT_NOT_FOUND","此預約沒有可查看的收據快照。");

  const bookingResult=await supabase.from("bookings")
    .select("id,member_id,booking_date,start_time,end_time,starts_next_day,status,completed_at,updated_at")
    .eq("id",bookingId).maybeSingle();
  if(bookingResult.error||!bookingResult.data) throw new ApiError(500,"DATABASE_ERROR","預約核對資料暫時無法讀取。");

  const [memberResult,itemsResult]=await Promise.all([
    supabase.from("members").select("member_code,display_name,surname,salutation").eq("id",bookingResult.data.member_id).maybeSingle(),
    supabase.from("booking_items").select("service_title,quantity,unit_price_amount,service_type").eq("booking_id",bookingId).order("created_at",{ascending:true}),
  ]);
  if(memberResult.error||itemsResult.error) throw new ApiError(500,"DATABASE_ERROR","預約核對資料暫時無法讀取。");

  const signed=await supabase.storage.from(BUCKET).createSignedUrl(String(result.data.object_path),120);
  if(signed.error||!signed.data?.signedUrl) throw new ApiError(503,"RECEIPT_VIEW_UNAVAILABLE","目前無法建立安全檢視連結。");

  const member:any=memberResult.data||{};
  return {
    receiptId:result.data.receipt_id,
    signedUrl:signed.data.signedUrl,
    expiresInSeconds:120,
    boundAt:result.data.bound_at,
    booking:{
      bookingId:String(bookingResult.data.id||""),
      bookingDate:String(bookingResult.data.booking_date||""),
      startTime:String(bookingResult.data.start_time||"").slice(0,5),
      endTime:String(bookingResult.data.end_time||"").slice(0,5),
      startsNextDay:Boolean(bookingResult.data.starts_next_day),
      status:String(bookingResult.data.status||""),
      completedAt:bookingResult.data.completed_at,
      updatedAt:bookingResult.data.updated_at,
      member:{
        memberCode:String(member.member_code||""),
        displayName:String(member.display_name||""),
        surname:String(member.surname||""),
        salutation:String(member.salutation||""),
      },
      items:(itemsResult.data||[]).map((item:any)=>({
        title:String(item.service_title||"預約項目"),
        quantity:Math.max(1,Number(item.quantity||1)),
        unitPriceAmount:Math.max(0,Number(item.unit_price_amount||0)),
        serviceType:String(item.service_type||""),
      })),
    },
  };
}


function selectionLimit(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : 1;
}

function normalizeAccessibleBenefits(value: unknown): Array<{kind:"points"|"event";id:string}> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400,"INVALID_BOOKING_BENEFITS","預約票券資料格式不正確。");
  const seen = new Set<string>();
  return value.map(raw => {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const kind = asText(item.kind,20).toLowerCase();
    const id = asText(item.id,160);
    const key = `${kind}:${id}`;
    if ((kind !== "points" && kind !== "event") || !id || seen.has(key)) {
      throw new ApiError(400,"INVALID_BOOKING_BENEFITS","預約票券資料格式不正確。");
    }
    seen.add(key);
    return {kind:kind as "points"|"event",id};
  });
}


// Only snapshot mode uses this preview. Actual authorization is repeated inside
// prepare_snapshot_receipt_v2 and later checked against server-stored proof.
async function snapshotGeoTicketPreview(
  supabase:SupabaseClient,memberId:string,items:any[],location:unknown,
):Promise<any[]>{
  const restricted=items.filter(item=>item?.requiresLocation===true && item?.selectionId && !item?.claimRequired);
  if(!restricted.length) return items;
  const raw=location && typeof location==="object" ? location as Json : {};
  const latitude=Number(raw.latitude),longitude=Number(raw.longitude),accuracy=Number(raw.accuracy),timestamp=Number(raw.timestamp);
  const valid=Number.isFinite(latitude)&&Math.abs(latitude)<=90&&Number.isFinite(longitude)&&Math.abs(longitude)<=180
    &&Number.isFinite(accuracy)&&accuracy>0&&accuracy<=100&&Number.isFinite(timestamp)
    &&timestamp>=Date.now()-120000&&timestamp<=Date.now()+30000;
  if(!valid) return items.map(item=>item?.requiresLocation===true
    ? {...item,selectable:false,disabledReason:"請先在快照模式完成 GPS 定位，再登記此票券。"}:item);
  const fix={latitude,longitude,accuracy,observedAt:new Date(timestamp).toISOString()};
  const pointIds=restricted.filter(item=>item.kind==="points").map(item=>String(item.selectionId));
  const claimIds=restricted.filter(item=>item.kind==="event").map(item=>String(item.selectionId));
  const [points,claims]=await Promise.all([
    pointIds.length?supabase.from("point_tickets").select("ticket_id,redemption_locations")
      .eq("member_id",memberId).in("ticket_id",pointIds):Promise.resolve({data:[],error:null}),
    claimIds.length?supabase.from("event_ticket_claims").select("claim_id,event_ticket_id")
      .eq("member_id",memberId).in("claim_id",claimIds):Promise.resolve({data:[],error:null}),
  ]);
  if(points.error||claims.error) throw dbError(points.error||claims.error);
  const sourceIds=[...new Set((claims.data||[]).map((claim:any)=>String(claim.event_ticket_id)))];
  const sources=sourceIds.length
    ? await supabase.from("event_tickets").select("id,redemption_locations").in("id",sourceIds)
    : {data:[],error:null};
  if(sources.error) throw dbError(sources.error);
  const pointsById=new Map((points.data||[]).map((row:any)=>[String(row.ticket_id),row.redemption_locations]));
  const eventById=new Map((sources.data||[]).map((row:any)=>[String(row.id),row.redemption_locations]));
  const claimLocations=new Map((claims.data||[]).map((row:any)=>[String(row.claim_id),eventById.get(String(row.event_ticket_id))]));
  const checked=await Promise.all(restricted.map(async item=>{
    const allowed=item.kind==="points"?pointsById.get(String(item.selectionId)):claimLocations.get(String(item.selectionId));
    if(!Array.isArray(allowed)||!allowed.length) return {key:item.kind+":"+item.selectionId,allowed:false,reason:"管理端尚未設定有效的票券可使用地點。"};
    const result=await supabase.rpc("verify_ticket_redemption_locations",{p_locations:allowed,p_location:fix});
    if(result.error){
      const failure=String(result.error.message||"");
      if(/LOCATION_OUT_OF_RANGE|LOCATION_INVALID|LOCATION_REQUIRED/.test(failure))
        return {key:item.kind+":"+item.selectionId,allowed:false,reason:"目前不在管理端設定的可使用地點範圍；請抵達指定地點後重新定位。"};
      throw dbError(result.error);
    }
    return {key:item.kind+":"+item.selectionId,allowed:true,reason:""};
  }));
  const results=new Map(checked.map(x=>[x.key,x]));
  return items.map(item=>{
    if(item?.requiresLocation!==true) return item;
    const checked=results.get(item.kind+":"+item.selectionId);
    // GPS is one requirement, never an override of ticket ownership, tier,
    // reservation-budget, or issuance eligibility evaluated by the catalog.
    const canUse=checked?.allowed===true && item.selectable===true
      && item.claimRequired!==true && !!item.selectionId;
    return {...item,selectable:canUse,
      disabledReason:canUse?"":checked?.allowed!==true
        ? checked?.reason||"此票券目前未通過指定地點 GPS 驗證。"
        : String(item.disabledReason||"此票券目前不符合快照登記條件。")};
  });
}

async function accessibleBenefitCatalog(supabase:SupabaseClient,member:any,currentBookingId="",location:unknown=null):Promise<Json>{
  const tierResult=await supabase.rpc("current_tier_key",{p_member_id:member.id});
  if(tierResult.error) throw dbError(tierResult.error);
  const raw=await loadBookingBenefits(
    supabase,
    member,
    String(tierResult.data||"general"),
    new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),
    currentBookingId,
  );
  const items=(Array.isArray(raw?.items)?raw.items:[])
    .filter((item:any)=>["points","event"].includes(String(item?.kind||"")))
    .map((item:any)=>item?.kind==="event"&&item?.claimRequired===true
      ? {...item,selectable:false,disabledReason:"會員尚未領取此活動票券；管理員不可代替會員領取。"}
      : item);
  // Snapshot is retrospective: a later pending or confirmed booking must keep its own
  // reserved points and ticket, but surplus points may independently fund now.
  // This exception is snapshot-only; general booking remains one ticket / ID.
  const pendingPointIds=items.filter((item:any)=>item.kind==="points"
    && item.reservedForBooking===true && item.selectionId)
    .map((item:any)=>String(item.selectionId));
  const futurePointRefs=new Set<string>();
  if(pendingPointIds.length){
    const reserved=await supabase.from("booking_benefit_selections")
      .select("benefit_ref,booking_id").eq("member_id",String(member.id))
      .eq("benefit_kind","points").eq("status","pending")
      .in("benefit_ref",pendingPointIds);
    if(reserved.error) throw dbError(reserved.error);
    const bookingIds=[...new Set((reserved.data||[]).map((row:any)=>String(row.booking_id||"")).filter(Boolean))];
    if(bookingIds.length){
      const bookings=await supabase.from("bookings")
        .select("id,status,start_at,completed_at").eq("member_id",String(member.id))
        .in("id",bookingIds);
      if(bookings.error) throw dbError(bookings.error);
      const futureIds=new Set((bookings.data||[]).filter((row:any)=>
        (row.status==="pending" || row.status==="confirmed") && !row.completed_at &&
        Date.parse(String(row.start_at||"").replace(" ","T").replace(/Z$/,"")+"+08:00")>Date.now()
      ).map((row:any)=>String(row.id)));
      for(const row of reserved.data||[]){
        if(futureIds.has(String(row.booking_id))) futurePointRefs.add(String(row.benefit_ref));
      }
    }
  }
  const snapshotCandidates=items.map((item:any)=>{
    if(item.kind!=="points" || item.reservedForBooking!==true) return item;
    const cost=Math.max(0,Number(item.pointCost)||0);
    const enough=cost>0 && Number(item.pointBalance)>=cost;
    const future=futurePointRefs.has(String(item.selectionId));
    const selectable=future && enough;
    return {...item,selectable,
      disabledReason:selectable?"":!future
        ?"此票券已被其他預約使用或保留，且該預約不屬於尚未開始的未來預約。"
        :`一般預約已保留其所需點數，剩餘 ${Math.max(0,Number(item.pointBalance)||0)} 點，不足以再登記此票券（需 ${cost} 點）。`,
      conditionLabel:selectable
        ?String(item.conditionLabel||"")+" · 已保留下次一般預約所需點數，剩餘點數仍足以登記本次快照"
        :item.conditionLabel};
  });
  const snapshotItems=await snapshotGeoTicketPreview(supabase,String(member.id),snapshotCandidates,location);
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const dayStart=new Date(today+"T00:00:00+08:00");
  const dayEnd=new Date(dayStart.getTime()+86400000);
  const used=await supabase.from("event_ticket_claims")
    .select("id",{count:"exact",head:true})
    .eq("member_id",String(member.id)).eq("status","used")
    .gte("used_at",dayStart.toISOString()).lt("used_at",dayEnd.toISOString());
  if(used.error) throw dbError(used.error);
  return {
    asOf:raw?.asOf||new Date().toISOString(),
    usedTodayCount:Math.max(0,Number(used.count||0)),
    eventTicketMaxPerDay:selectionLimit(raw?.eventTicketMaxPerDay),
    pointTicketMaxPerRedemption:selectionLimit(raw?.pointTicketMaxPerRedemption),
    items:snapshotItems,
  };
}

async function validateAccessibleBenefits(
  supabase:SupabaseClient,
  receiptId:string,
  bookingId:string,
  rawItems:unknown,
  rawBenefits:unknown,
):Promise<Array<{kind:"points"|"event";id:string}>>{
  const requested=normalizeAccessibleBenefits(rawBenefits);
  if(!requested.length) return requested;

  const receipt=await supabase.from("booking_receipts")
    .select("member_id,status")
    .eq("receipt_id",receiptId)
    .eq("submission_mode","accessible")
    .maybeSingle();
  if(receipt.error) throw dbError(receipt.error);
  if(!receipt.data) throw new ApiError(404,"RECEIPT_NOT_FOUND","找不到這筆收據。");
  // A completed receipt must reach the idempotent register RPC even after
  // its tickets have been consumed.
  if(String(receipt.data.status||"")==="bound") return [];

  let serviceIds:string[]=[];
  if(bookingId){
    const booking=await supabase.from("bookings")
      .select("id,member_id,status,booking_items(service_id)")
      .eq("id",bookingId).maybeSingle();
    if(booking.error) throw dbError(booking.error);
    if(!booking.data||String(booking.data.member_id)!==String(receipt.data.member_id)) {
      throw new ApiError(403,"BOOKING_NOT_OWNED","不可操作其他會員的預約。");
    }
    if(String(booking.data.status)!=="confirmed") {
      throw new ApiError(409,"BOOKING_NOT_EDITABLE","已完成的預約不可再變更票券。");
    }
    serviceIds=(booking.data.booking_items||[]).map((row:any)=>String(row.service_id||"")).filter(Boolean);
  }else{
    serviceIds=(Array.isArray(rawItems)?rawItems:[])
      .map((row:any)=>asText(row?.serviceId,60)).filter(Boolean);
  }

  // The display catalog intentionally contains only the latest offer per
  // reward/event, and may omit an older still-valid issued ticket. Never use
  // that truncated catalog as the authorization source for review.
  // This RPC validates each exact ticket ID, owner, status, expiry, tier,
  // GPS restrictions, concurrent reservation, balance and redemption limits.
  // register_snapshot_receipt_v2 repeats the check inside settlement's
  // transaction so there is no approval race.
  const canonical=await supabase.rpc("validate_snapshot_ticket_selection",{
    p_member:receipt.data.member_id,
    p_booking:null,
    p_benefits:requested,
    p_receipt_id:receiptId,
  });
  if(canonical.error) throw dbError(canonical.error);

  // Check service-specific rules against the *issued* ticket's source,
  // rather than against the current/latest catalog reward. The database
  // revalidates the ticket again when it binds and redeems the benefits.
  const pointIds=requested.filter(item=>item.kind==="points").map(item=>item.id);
  const eventIds=requested.filter(item=>item.kind==="event").map(item=>item.id);
  const [points,claims]=await Promise.all([
    pointIds.length
      ? supabase.from("point_tickets").select("ticket_id,reward_id").eq("member_id",receipt.data.member_id).in("ticket_id",pointIds)
      : Promise.resolve({data:[],error:null}),
    eventIds.length
      ? supabase.from("event_ticket_claims").select("claim_id,event_ticket_id").eq("member_id",receipt.data.member_id).in("claim_id",eventIds)
      : Promise.resolve({data:[],error:null}),
  ]);
  if(points.error) throw dbError(points.error);
  if(claims.error) throw dbError(claims.error);
  const pointRows=points.data||[];
  const claimRows=claims.data||[];
  const rewardIds=[...new Set(pointRows.map((row:any)=>String(row.reward_id||"")).filter(Boolean))];
  const eventSourceIds=[...new Set(claimRows.map((row:any)=>String(row.event_ticket_id||"")).filter(Boolean))];
  const [rewards,events]=await Promise.all([
    rewardIds.length
      ? supabase.from("point_card_rewards").select("id,required_service_ids,required_service_match_mode").in("id",rewardIds)
      : Promise.resolve({data:[],error:null}),
    eventSourceIds.length
      ? supabase.from("event_tickets").select("id,required_service_ids,required_service_match_mode").in("id",eventSourceIds)
      : Promise.resolve({data:[],error:null}),
  ]);
  if(rewards.error) throw dbError(rewards.error);
  if(events.error) throw dbError(events.error);
  const pointsById=new Map(pointRows.map((row:any)=>[String(row.ticket_id),row]));
  const claimsById=new Map(claimRows.map((row:any)=>[String(row.claim_id),row]));
  const rewardsById=new Map((rewards.data||[]).map((row:any)=>[String(row.id),row]));
  const eventsById=new Map((events.data||[]).map((row:any)=>[String(row.id),row]));
  const selectedServices=new Set(serviceIds);
  for(const selection of requested){
    const issued=selection.kind==="points"?pointsById.get(selection.id):claimsById.get(selection.id);
    const rule=issued&&(selection.kind==="points"
      ? rewardsById.get(String(issued.reward_id||""))
      : eventsById.get(String(issued.event_ticket_id||"")));
    if(!issued||(selection.kind==="event"&&!rule)) {
      throw new ApiError(409,"BOOKING_BENEFIT_NOT_AVAILABLE","所選票券的規則已變動，請重新確認票券。");
    }
    // A historic point reward may have been removed after ticket issuance.
    // In that case the canonical booking service matcher treats it as
    // unrestricted rather than revoking an otherwise valid issued ticket.
    const required=(Array.isArray(rule?.required_service_ids)?rule.required_service_ids:[])
      .map((id:unknown)=>String(id||"")).filter(Boolean);
    const eligible=!required.length||(rule.required_service_match_mode==="all"
      ? required.every((id:string)=>selectedServices.has(id))
      : required.some((id:string)=>selectedServices.has(id)));
    if(!eligible){
      throw new ApiError(409,"BOOKING_BENEFIT_SERVICE_REQUIRED","其中一張票券不符合本次實際服務項目，請重新核對。");
    }
  }
  return requested;
}

// A receipt's held-ticket IDs must remain reviewable even when the latest-offer
// catalog hides older issues of the same reward or truncates its display list.
// This is an admin-only read path; the approval RPC remains the final authority.
async function snapshotRequestedBenefitOptions(
  supabase:SupabaseClient, memberId:string, rawBenefits:unknown, receiptId:string,
):Promise<any[]>{
  const requested=normalizeAccessibleBenefits(rawBenefits);
  return await Promise.all(requested.map(async selection=>{
    const eligible=await supabase.rpc("validate_snapshot_ticket_selection",{
      p_member:memberId,p_booking:null,p_benefits:[selection],p_receipt_id:receiptId,
    });
    // Expected business-rule failures make a ticket visibly unavailable; a
    // database/service failure must surface as an error rather than disguising it.
    const businessFailures=[
      "BOOKING_BENEFIT_NOT_AVAILABLE","BOOKING_BENEFIT_RESERVED",
      "BOOKING_BENEFIT_LOCATION_REQUIRED","MEMBERSHIP_REQUIRED",
      "POINT_TICKET_INSUFFICIENT_POINTS","EVENT_TICKET_DAILY_LIMIT_REACHED",
      "TICKET_BATCH_LIMIT_EXCEEDED",
    ];
    const failure=String(eligible.error?.message||"");
    if(eligible.error&&!businessFailures.some(code=>failure.includes(code))) throw dbError(eligible.error);
    const selectable=!eligible.error;
    const base={
      kind:selection.kind,selectionId:selection.id,
      selectable,claimRequired:false,
      disabledReason:selectable?"":failure.includes("BOOKING_BENEFIT_LOCATION_REQUIRED")
        ? "此票券在送出快照時未通過指定地點 GPS 驗證，無法補登。"
        : "票券已失效、額度不足或已被其他預約選用，請重新核對。",
    };
    if(selection.kind==="points"){
      const issued=await supabase.from("point_tickets")
        .select("ticket_id,ticket_title,point_card_id,reward_id,threshold_stamps")
        .eq("member_id",memberId).eq("ticket_id",selection.id).maybeSingle();
      if(issued.error) throw dbError(issued.error);
      if(!issued.data) return {...base,title:"原登記集點卡票券",selectable:false};
      const [card,balance,reward]=await Promise.all([
        supabase.from("point_cards").select("id,title").eq("id",issued.data.point_card_id).maybeSingle(),
        supabase.from("point_balances").select("stamps").eq("member_id",memberId).eq("point_card_id",issued.data.point_card_id).maybeSingle(),
        issued.data.reward_id
          ? supabase.from("point_card_rewards").select("required_service_ids,required_service_match_mode").eq("id",issued.data.reward_id).maybeSingle()
          : Promise.resolve({data:null,error:null}),
      ]);
      if(card.error||balance.error||reward.error) throw dbError(card.error||balance.error||reward.error);
      return {
        ...base,title:String(issued.data.ticket_title||"集點卡票券"),
        cardId:String(issued.data.point_card_id),cardTitle:String(card.data?.title||"集點卡"),
        pointCost:Math.max(0,Number(issued.data.threshold_stamps||0)),
        pointBalance:Math.max(0,Number(balance.data?.stamps||0)),
        requiredServiceIds:reward.data?.required_service_ids||[],
        requiredServiceMatchMode:reward.data?.required_service_match_mode==="all"?"all":"any",
        subtitle:"會員原先登記的集點卡票券",
      };
    }
    const claim=await supabase.from("event_ticket_claims")
      .select("claim_id,ticket_title,event_ticket_id")
      .eq("member_id",memberId).eq("claim_id",selection.id).maybeSingle();
    if(claim.error) throw dbError(claim.error);
    if(!claim.data) return {...base,title:"原登記活動票券",selectable:false};
    const event=await supabase.from("event_tickets")
      .select("required_service_ids,required_service_match_mode")
      .eq("id",claim.data.event_ticket_id).maybeSingle();
    if(event.error) throw dbError(event.error);
    return {
      ...base,title:String(claim.data.ticket_title||"活動票券"),
      selectable:selectable&&!!event.data,
      requiredServiceIds:event.data?.required_service_ids||[],
      requiredServiceMatchMode:event.data?.required_service_match_mode==="all"?"all":"any",
      subtitle:"會員原先登記的活動票券",
    };
  }));
}

async function registrationOptions(supabase:SupabaseClient,body:Json):Promise<Json>{
  const receipt=await supabase.from("booking_receipts").select("member_id,status,updated_at,requested_benefits,requested_booking_id")
    .eq("receipt_id",asText(body.receiptId,80)).eq("submission_mode","accessible").maybeSingle();
  if(receipt.error) throw new ApiError(500,"DATABASE_ERROR","收據資料暫時無法讀取。");
  if(!receipt.data) throw new ApiError(404,"RECEIPT_NOT_FOUND","找不到這筆收據。");

  const requestedBookingId=asText(body.bookingId,80);
  let currentBooking:any=null;
  if(requestedBookingId){
    const current=await supabase.from("bookings")
      .select("id,member_id,status,booking_items(service_id)")
      .eq("id",requestedBookingId)
      .maybeSingle();
    if(current.error) throw dbError(current.error);
    if(!current.data||String(current.data.member_id)!==String(receipt.data.member_id)) throw new ApiError(403,"BOOKING_NOT_OWNED","不可操作其他會員的預約。");
    currentBooking=current.data;
  }

  const [services,settings,bookings,rewardRules,memberResult,currentBenefitsResult]=await Promise.all([
    supabase.from("booking_services").select("id,title,duration_minutes,service_type,counts_toward_membership").eq("is_active",true).is("deleted_at",null).neq("id","00000000-0000-4000-8000-000000000010").order("title"),
    supabase.from("booking_settings").select("primary_technician_id,require_primary_technician").eq("id",1).maybeSingle(),
    supabase.from("bookings").select("id,booking_date,start_time,status,booking_items(service_id,service_title),booking_receipts!booking_receipts_booking_id_fkey(status)").eq("member_id",receipt.data.member_id)
      .in("status",["confirmed","completed"]).order("booking_date",{ascending:false}).limit(80),
    supabase.from("booking_service_type_rewards").select("minutes_per_point,booking_service_types(name),point_cards(title)"),
    supabase.from("members").select("id,birthday").eq("id",receipt.data.member_id).maybeSingle(),
    requestedBookingId
      ? supabase.from("booking_benefit_selections")
          .select("benefit_kind,benefit_ref,title_snapshot,status,redeemed_at,result")
          .eq("booking_id",requestedBookingId)
          .in("benefit_kind",["points","event"])
          .order("selected_at",{ascending:true})
      : Promise.resolve({data:[],error:null}),
  ]);
  if(services.error||settings.error||bookings.error||rewardRules.error||memberResult.error||currentBenefitsResult.error) throw new ApiError(500,"DATABASE_ERROR","服務登記選項暫時無法讀取。");
  if(!memberResult.data) throw new ApiError(404,"MEMBER_NOT_FOUND","找不到會員資料。");

  const benefitCatalog=await accessibleBenefitCatalog(
    supabase,
    memberResult.data,
    currentBooking&&String(currentBooking.status)==="confirmed"?requestedBookingId:"",
  );
  const heldOptions=receipt.data.status==="awaiting_review"
    ? await snapshotRequestedBenefitOptions(supabase,receipt.data.member_id,receipt.data.requested_benefits,asText(body.receiptId,80))
    : [];
  // Exact receipt-held tickets override stale/latest promotional preview rows.
  // This also restores earlier issued ticket IDs missing from the catalog.
  const heldKeys=new Set(heldOptions.map(option=>`${option.kind}:${option.selectionId}`));
  benefitCatalog.items=[
    ...(Array.isArray(benefitCatalog.items)?benefitCatalog.items:[])
      .filter((item:any)=>!heldKeys.has(`${item.kind}:${item.selectionId}`)),
    ...heldOptions,
  ];

  return {
    requestedBenefits:receipt.data.requested_benefits||[],requestedBookingId:receipt.data.requested_booking_id||"",
    rewardRules:(rewardRules.data||[]).map((r:any)=>({serviceType:r.booking_service_types?.name||"",minutesPerPoint:r.minutes_per_point,cardTitle:r.point_cards?.title||""})),
    services:services.data||[],
    primaryTechnicianConfigured:Boolean(settings.data?.primary_technician_id),
    requirePrimaryTechnician:settings.data?.require_primary_technician !== false,
    benefitCatalog,
    currentBookingStatus:currentBooking?String(currentBooking.status||""):"",
    currentBookingServiceIds:currentBooking
      ? (currentBooking.booking_items||[]).map((item:any)=>String(item.service_id||"")).filter(Boolean)
      : [],
    currentBenefits:(currentBenefitsResult.data||[]).map((item:any)=>({
      kind:String(item.benefit_kind||""),
      id:String(item.benefit_ref||""),
      title:String(item.title_snapshot||"預約票券"),
      status:String(item.status||"pending"),
      cancellationReason:String(item.result?.cancellationReason||""),
      redeemedAt:item.redeemed_at||null,
    })),
    bookings:(bookings.data||[]).filter((b:any)=>!(b.booking_receipts||[]).some((r:any)=>["pending_upload","awaiting_review","bound"].includes(r.status)))
      .map((b:any)=>({
        bookingId:b.id,
        bookingDate:b.booking_date,
        startTime:String(b.start_time).slice(0,5),
        status:b.status,
        serviceIds:(b.booking_items||[]).map((i:any)=>String(i.service_id||"")).filter(Boolean),
        title:(b.booking_items||[]).map((i:any)=>i.service_title).join("、"),
      })),
  };
}

serveBusiness('booking-receipt-api',async(request:Request)=>{
  const origin=request.headers.get("Origin");
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:corsHeaders(origin)});
  if(request.method!=="POST") return response(origin,{ok:false,error:{code:"METHOD_NOT_ALLOWED",message:"只支援 POST。"}},405);
  if(origin&&!allowedOrigins().has(origin)) return response(origin,{ok:false,error:{code:"ORIGIN_DENIED",message:"不允許的來源。"}},403);

  try{
    const body=await readJsonObject(request,MAX_REQUEST_BYTES,ApiError);
    const action=asText(body.action,100);
    const userActions=new Set(["user.booking.receipt.list","user.booking.receipt.prepare","user.booking.receipt.finalize","user.booking.receipt.options","user.booking.receipt.cancel"]);
    const adminActions=new Set(["admin.booking.receipt.list","admin.booking.receipt.url","admin.booking.receipt.options","admin.booking.receipt.register","admin.booking.receipt.dismiss"]);
    if(!userActions.has(action)&&!adminActions.has(action)) throw new ApiError(404,"ACTION_NOT_FOUND","不支援的收據操作。");

    const supabase=dbClient();
    const expiredReceipts=await supabase.rpc("expire_stale_booking_receipts");
    if(expiredReceipts.error) console.warn("booking receipt stale cleanup failed", expiredReceipts.error.message);
    await drainCleanupQueue(supabase);

    let data:Json;
    if(userActions.has(action)){
      if(asText(body.clientType,20)!=="booking") throw new ApiError(403,"CLIENT_ACTION_MISMATCH","操作端與功能不相符。");
      const identity=await resolveUserIdentity(supabase,body);
      await consumeRateLimit(supabase,identity,action!=="user.booking.receipt.list"&&action!=="user.booking.receipt.options");
      const member=await requireMember(supabase,identity);
      if(action==="user.booking.receipt.list") data=await memberList(supabase,member,body);
      else if(action==="user.booking.receipt.options") {
        const catalog=await accessibleBenefitCatalog(supabase,member,"",body.location??null);
        // Snapshot receipts register member-held tickets without an advance reservation.
        // Normal ticket redemption keeps the global ticket_booking_required policy.
        data={...catalog,ticketBookingRequired:false};
      } else if(action==="user.booking.receipt.cancel") {
        const cancelled=await supabase.rpc("cancel_snapshot_receipt_request",{p_receipt_id:asText(body.receiptId,80),p_member_id:member.id,p_actor:identity.lineUserId,p_expected_updated_at:asText(body.expectedUpdatedAt,100)||null});
        if(cancelled.error) throw dbError(cancelled.error);
        data=cancelled.data||{};
      }
      else if(action==="user.booking.receipt.prepare") data=await prepare(supabase,identity,member,body);
      else data=await finalize(supabase,identity,member,body);
    }else{
      if(asText(body.clientType,20)!=="admin") throw new ApiError(403,"CLIENT_ACTION_MISMATCH","操作端與功能不相符。");
      const identity=await resolveAdminIdentity(body);
      await requireActiveAdminContract({supabase,identity,createError:(status,code,message,details=null)=>new ApiError(status,code,message,details)});
      await consumeRateLimit(supabase,identity,action!=="admin.booking.receipt.list"&&action!=="admin.booking.receipt.options");
      if(action==="admin.booking.receipt.list") data=await adminList(supabase);
      else if(action==="admin.booking.receipt.url") data=await adminUrl(supabase,body);
      else if(action==="admin.booking.receipt.options") data=await registrationOptions(supabase,body);
      else {
        const receiptId=asText(body.receiptId,80);
        const bookingId=asText(body.bookingId,80);
        const benefits=action==="admin.booking.receipt.dismiss"
          ? []
          : await validateAccessibleBenefits(
              supabase,
              receiptId,
              bookingId,
              Array.isArray(body.items)?body.items:[],
              body.benefits,
            );
        const result=action==="admin.booking.receipt.dismiss"
          ? await supabase.rpc("dismiss_accessible_receipt_request",{p_receipt_id:receiptId,p_expected_updated_at:asText(body.expectedUpdatedAt,100)||null,p_actor:identity.lineUserId})
          : await supabase.rpc("register_snapshot_receipt_v2",{
            p_receipt_id:receiptId,p_expected_receipt_updated_at:asText(body.expectedUpdatedAt,100)||null,p_actor:identity.lineUserId,
            p_booking_id:bookingId||null,p_booking_date:asText(body.bookingDate,10)||null,
            p_start_time:asText(body.startTime,8)||null,p_items:Array.isArray(body.items)?body.items:[],
            p_benefits:benefits,p_admin_note:asText(body.adminNote,500)
          });
        if(result.error) throw dbError(result.error);
        data=action==="admin.booking.receipt.dismiss"?{dismissed:true}:(result.data||{}) as Json;
      }
    }

    return response(origin,{ok:true,status:200,data});
  }catch(error){
    const e=error instanceof ApiError?error:new ApiError(500,"INTERNAL_ERROR","收據服務暫時無法完成操作。");
    return response(origin,{ok:false,status:e.status,error:{code:e.code,message:e.message,details:e.details}},e.status);
  }
});
