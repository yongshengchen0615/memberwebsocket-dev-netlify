import { summarizeE2EExecution, prepareE2EServiceRuleFixtures, normalizeFeatureCoverage, normalizeClientFeatureCoverage, evaluateSelectedScope } from "../_shared/e2e-coverage.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { verifyLineIdTokenContract, requireActiveAdminContract } from "../_shared/auth-contract.ts";
import { attachE2EDiagnosis, diagnoseE2EFailure, summarizeE2EFailureDiagnoses } from "../_shared/e2e-diagnostics.js";

type Json = Record<string, unknown>;
type CaseResult = {
  passed: boolean;
  skipped?: boolean;
  code: string;
  message: string;
  expected: unknown;
  actual: unknown;
};

const MAX_REQUEST_BYTES = 384_000;
const STANDARD_REQUEST_BYTES = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E2E_ARTIFACT_BUCKET = "e2e-failure-artifacts";
const BOOKING_RECEIPT_BUCKET = "booking-receipts";

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

function asText(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function allowedOrigins(): Set<string> {
  return new Set(
    [(env("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io"), "https://develop--memberwebsocket-dev-netlify.netlify.app"].join(",")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
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

function response(origin: string | null, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(origin: string | null, error: unknown): Response {
  const resolved = error instanceof ApiError
    ? error
    : new ApiError(500, "TEST_CONTROL_ERROR", "自動化測試服務暫時無法完成操作。");
  return response(origin, {
    ok: false,
    status: resolved.status,
    error: {
      code: resolved.code,
      message: resolved.message,
      details: resolved.details,
    },
  }, resolved.status);
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

async function purgeE2EArtifactStorage(supabase: any): Promise<number> {
  let count = 0;
  let offset = 0;
  const pageSize = 1000;

  for (let page = 0; page < 100; page += 1) {
    const listed = await supabase.storage.from(E2E_ARTIFACT_BUCKET).list("runs", {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (listed.error) {
      throw new ApiError(503, "TEST_ARTIFACT_LIST_FAILED", "目前無法盤點 E2E 失敗快照。", listed.error.message || null);
    }
    const rows = Array.isArray(listed.data) ? listed.data : [];
    count += rows.filter((item: any) => item?.id && String(item?.name || "").endsWith(".webp")).length;
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  const emptied = await supabase.storage.emptyBucket(E2E_ARTIFACT_BUCKET);
  if (emptied.error) {
    throw new ApiError(503, "TEST_ARTIFACT_PURGE_FAILED", "測試資料已清理，但 E2E 失敗快照清除失敗。", emptied.error.message || null);
  }
  return count;
}

async function purgeBookingReceiptCleanupQueue(supabase: any): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < 50; batch += 1) {
    const queued = await supabase
      .from("booking_receipt_cleanup_queue")
      .select("id,object_path")
      .order("id", { ascending: true })
      .limit(100);
    if (queued.error) {
      throw new ApiError(503, "RECEIPT_CLEANUP_READ_FAILED", "測試資料已清理，但收據快照清理佇列讀取失敗。");
    }
    const rows = Array.isArray(queued.data) ? queued.data : [];
    if (!rows.length) break;

    const paths = rows.map((row: any) => String(row.object_path || "")).filter(Boolean);
    if (paths.length) {
      const removed = await supabase.storage.from(BOOKING_RECEIPT_BUCKET).remove(paths);
      if (removed.error) {
        throw new ApiError(503, "RECEIPT_STORAGE_PURGE_FAILED", "測試資料已清理，但收據快照檔案清除失敗。", removed.error.message || null);
      }
      deleted += paths.length;
    }
    const ids = rows.map((row: any) => row.id);
    const cleared = await supabase.from("booking_receipt_cleanup_queue").delete().in("id", ids);
    if (cleared.error) {
      throw new ApiError(503, "RECEIPT_CLEANUP_QUEUE_FAILED", "收據快照已刪除，但清理佇列更新失敗。");
    }
  }
  return deleted;
}

function dbClient(): any {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function adminChannelId(): string {
  const value = env("LINE_ADMIN_CHANNEL_ID") || "2010791619";
  if (!/^\d{5,30}$/.test(value)) {
    throw new ApiError(503, "AUTH_CONFIG_MISSING", "LINE 管理端驗證設定尚未完成。");
  }
  return value;
}

async function audit(
  supabase: any,
  identity: { lineUserId: string },
  action: string,
  targetType: string,
  targetId: string,
  detail: Json = {},
): Promise<void> {
  const result = await supabase.from("audit_logs").insert({
    audit_id: "TST-" + crypto.randomUUID(),
    actor_line_user_id: identity.lineUserId,
    actor_role: "admin",
    action,
    target_type: targetType,
    target_id: targetId,
    result: "success",
    detail,
  });
  if (result.error) {
    throw new ApiError(503, "TEST_AUDIT_WRITE_FAILED", "測試資料已操作，但稽核紀錄寫入失敗。");
  }
}


async function emitRealtimeEvent(supabase: any, eventType: string): Promise<void> {
  const result = await supabase.from("realtime_events").insert({
    scope: "all",
    event_type: asText(eventType, 120),
  });
  if (result.error) {
    throw new ApiError(503, "TEST_REALTIME_EVENT_FAILED", "測試資料已更新，但即時同步事件建立失敗。");
  }
}

// Background browser timers can be throttled beyond a minute. Keep renewal at
// 15 seconds while allowing a bounded grace period; expired leases never revive.
const E2E_EXECUTION_LEASE_TTL_MINUTES = 5;

async function acquireE2EExecutionLease(
  supabase: any,
  identity: { lineUserId: string },
): Promise<Json> {
  const result = await supabase.rpc("admin_acquire_test_execution_lease", {
    p_actor: identity.lineUserId,
    p_ttl_minutes: E2E_EXECUTION_LEASE_TTL_MINUTES,
  });
  if (result.error || !UUID_RE.test(String(result.data || ""))) {
    throw new ApiError(503, "E2E_LEASE_ACQUIRE_FAILED", "目前無法鎖定完整 E2E 執行期間。", result.error?.message || null);
  }
  return { leaseId: String(result.data), expiresInMinutes: E2E_EXECUTION_LEASE_TTL_MINUTES };
}

async function releaseE2EExecutionLease(
  supabase: any,
  identity: { lineUserId: string },
  body: Json,
): Promise<Json> {
  const leaseId = asText(body.leaseId, 80);
  if (!UUID_RE.test(leaseId)) {
    throw new ApiError(400, "INVALID_E2E_LEASE_ID", "E2E 執行鎖識別不正確。");
  }
  const result = await supabase.rpc("admin_release_test_execution_lease", {
    p_lease_id: leaseId,
    p_actor: identity.lineUserId,
  });
  if (result.error) {
    throw new ApiError(503, "E2E_LEASE_RELEASE_FAILED", "目前無法解除完整 E2E 執行鎖。", result.error.message || null);
  }
  return { released: result.data === true };
}

async function heartbeatE2EExecutionLease(
  supabase: any,
  identity: { lineUserId: string },
  body: Json,
): Promise<Json> {
  const leaseId = asText(body.leaseId, 80);
  if (!UUID_RE.test(leaseId)) {
    throw new ApiError(400, "INVALID_E2E_LEASE_ID", "E2E 執行鎖識別不正確。");
  }
  const result = await supabase.rpc("admin_heartbeat_test_execution_lease", {
    p_lease_id: leaseId,
    p_actor: identity.lineUserId,
    p_ttl_minutes: E2E_EXECUTION_LEASE_TTL_MINUTES,
  });
  if (result.error) {
    throw new ApiError(503, "E2E_LEASE_HEARTBEAT_FAILED", "目前無法續租完整 E2E 執行鎖。", result.error.message || null);
  }
  return { renewed: result.data === true, expiresInMinutes: E2E_EXECUTION_LEASE_TTL_MINUTES };
}

async function prepareTestAccountConsents(
  supabase: any,
  identity: { lineUserId: string },
  body: Json,
): Promise<Json> {
  const requested = Array.isArray(body.memberIds) ? body.memberIds : [];
  const memberIds = [...new Set(requested.map((value) => asText(value, 80)).filter(Boolean))];
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!memberIds.length || memberIds.length > 10 || memberIds.some((id) => !uuidPattern.test(id))) {
    throw new ApiError(400, "INVALID_TEST_MEMBER_SELECTION", "E2E 測試會員清單不正確。");
  }

  // Validate the selected identities before deciding whether consent preparation is
  // needed. A missing legal document must never turn this admin-only fixture
  // helper into a way to bless arbitrary member ids.
  const membersResult = await supabase
    .from("members")
    .select("id,is_test_account,status,membership_status")
    .in("id", memberIds);
  if (membersResult.error) throw new ApiError(503, "TEST_MEMBER_READ_FAILED", "目前無法確認 E2E 測試會員。");
  const eligibleIds = new Set(
    (membersResult.data || [])
      .filter((row: any) => row.is_test_account === true && row.status === "active" && row.membership_status === "active")
      .map((row: any) => String(row.id)),
  );
  if (eligibleIds.size !== memberIds.length || memberIds.some((id) => !eligibleIds.has(id))) {
    throw new ApiError(403, "TEST_MEMBER_SELECTION_FORBIDDEN", "E2E 條款前置只能套用到啟用中的測試會員。");
  }

  // The member API resolves targeted E2E terms first, falling back to
  // production terms. Never assign one member's targeted terms to another.
  const [productionResult, e2eResult] = await Promise.all([
    supabase.from("membership_terms")
      .select("id,scope,e2e_member_id,version,required,reconsent_existing,effective_at,activated_at")
      .eq("status", "active").eq("scope", "production").maybeSingle(),
    supabase.from("membership_terms")
      .select("id,scope,e2e_member_id,version,required,reconsent_existing,effective_at,activated_at")
      .eq("status", "active").eq("scope", "e2e").in("e2e_member_id", memberIds),
  ]);
  if (productionResult.error || e2eResult.error) {
    throw new ApiError(503, "MEMBERSHIP_TERMS_READ_FAILED", "目前無法讀取 E2E 會員條款前置狀態。");
  }
  const nowMs = Date.now();
  const effective = (term: any): boolean =>
    Boolean(term?.id) && Number.isFinite(new Date(term.effective_at).getTime()) &&
    new Date(term.effective_at).getTime() <= nowMs;
  const targeted = new Map<string, any>();
  for (const term of e2eResult.data || []) {
    if (effective(term) && memberIds.includes(String(term.e2e_member_id))) {
      targeted.set(String(term.e2e_member_id), term);
    }
  }
  const production = effective(productionResult.data) ? productionResult.data : null;
  const applicable = memberIds.map((memberId) => ({
    memberId,
    terms: targeted.get(memberId) || production,
  }));
  // Active test accounts require reconsent only when their currently
  // applicable terms request it. Optional documents must not be fabricated.
  const required = applicable.filter(({ terms }) => terms?.reconsent_existing === true);
  if (!required.length) {
    return {
      testMemberCount: memberIds.length,
      insertedCount: 0,
      currentConsentCount: memberIds.length,
      consentRequiredCount: 0,
      termsVersion: null,
      termsConfigured: applicable.some(({ terms }) => Boolean(terms?.id)),
      skipped: true,
      skipCode: "MEMBERSHIP_RECONSENT_NOT_REQUIRED",
    };
  }

  const termIds = [...new Set(required.map(({ terms }) => String(terms.id)))];
  const existingResult = await supabase.from("membership_consents")
    .select("member_id,terms_id,result")
    .eq("result", "accepted")
    .in("terms_id", termIds).in("member_id", memberIds);
  if (existingResult.error) throw new ApiError(503, "MEMBERSHIP_CONSENT_READ_FAILED", "目前無法確認測試會員條款同意狀態。");
  const pairKey = (memberId: string, termsId: string): string => memberId + ":" + termsId;
  const existing = new Set((existingResult.data || []).map((row: any) => pairKey(String(row.member_id), String(row.terms_id))));
  const missing = required.filter(({ memberId, terms }) => !existing.has(pairKey(memberId, String(terms.id))));
  if (missing.length) {
    const insertResult = await supabase.from("membership_consents").upsert(
      missing.map(({ memberId, terms }) => ({ member_id: memberId, terms_id: terms.id, result: "accepted" })),
      { onConflict: "member_id,terms_id", ignoreDuplicates: true },
    );
    if (insertResult.error) throw new ApiError(503, "MEMBERSHIP_CONSENT_FIXTURE_FAILED", "目前無法建立測試會員條款前置資料。");
  }

  const verifyResult = await supabase.from("membership_consents")
    .select("member_id,terms_id,result")
    .eq("result", "accepted")
    .in("terms_id", termIds).in("member_id", memberIds);
  if (verifyResult.error) throw new ApiError(503, "MEMBERSHIP_CONSENT_READ_FAILED", "目前無法驗證測試會員條款前置資料。");
  const verified = new Set((verifyResult.data || []).map((row: any) => pairKey(String(row.member_id), String(row.terms_id))));
  const readyCount = memberIds.length - required.filter(({ memberId, terms }) =>
    !verified.has(pairKey(memberId, String(terms.id)))).length;
  if (readyCount !== memberIds.length) {
    throw new ApiError(503, "MEMBERSHIP_CONSENT_FIXTURE_INCOMPLETE", "測試會員條款前置資料未完整建立。");
  }

  const detail = {
    testMemberCount: memberIds.length,
    insertedCount: missing.length,
    currentConsentCount: readyCount,
    consentRequiredCount: required.length,
    termsVersion: [...new Set(required.map(({ terms }) => asText(terms.version, 80)))].join(", "),
    termsConfigured: true,
    skipped: false,
  };
  await audit(supabase, identity, "test_control.test_consent.prepare", "membership_terms", "per-member", detail);
  await emitRealtimeEvent(supabase, "test_mode.membership_consent.prepared");
  return detail;
}

async function prepareComplexFixtures(
  supabase: any,
  identity: { lineUserId: string },
  body: Json,
): Promise<Json> {
  const complexityLevel = Math.max(1, Math.min(8, Number(body.complexityLevel || 1) || 1));
  const seed = asText(body.seed, 160);
  const requestedTag = asText(body.runTag, 40).replace(/[^A-Za-z0-9_-]/g, "");
  const runTag = requestedTag || (new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + crypto.randomUUID().replaceAll("-", "").slice(0, 8));
  const rpc = await supabase.rpc("admin_prepare_complex_e2e_fixtures_v2", {
    p_run_tag: runTag,
    p_actor: identity.lineUserId,
  });
  if (rpc.error) {
    throw new ApiError(503, "E2E_FIXTURE_PREPARE_FAILED", "目前無法建立完整 E2E 前置資料。", rpc.error.message || null);
  }
  const fixtureBase = rpc.data && typeof rpc.data === "object" ? rpc.data : {};
  let serviceRules;
  try { serviceRules = await prepareE2EServiceRuleFixtures(supabase, fixtureBase); }
  catch (_) { throw new ApiError(503, "E2E_RULE_FIXTURE_PREPARE_FAILED", "目前無法建立服務項目限制測試票券。"); }
  const fixture = {
    ...(fixtureBase as Json),
    ...serviceRules,
    eventTickets: Number(fixtureBase.eventTickets || 0) + serviceRules.serviceRuleTickets,
    complexityLevel,
    seed,
  };
  await audit(supabase, identity, "test_control.fixture.prepare", "e2e_fixture", runTag, fixture as Json);
  await emitRealtimeEvent(supabase, "test_mode.fixture.prepared");
  return fixture as Json;
}

function runCode(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return "QA-" + date + "-" + suffix;
}

const E2E_MODULE_KEYS = ["member", "points", "event", "calendar", "integration", "booking"] as const;

function selectedE2EModules(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.some((key) => typeof key !== "string" || !E2E_MODULE_KEYS.includes(key as typeof E2E_MODULE_KEYS[number]))) {
    throw new ApiError(400, "INVALID_E2E_MODULE_SELECTION", "請至少勾選一個有效的 E2E 模組。");
  }
  return E2E_MODULE_KEYS.filter((key) => value.includes(key));
}

const REPLAY_SURFACES = ["member", "points", "event", "calendar", "booking"] as const;
function replayKeyList(value: unknown, label: string, max = 80): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new ApiError(400,"INVALID_REPLAY_MANIFEST",label+" 節點清單不正確。");
  const keys=value.map((item)=>asText(item,120));
  if(keys.some((key)=>!/^[A-Z0-9_]+$/.test(key)) || new Set(keys).size!==keys.length) throw new ApiError(400,"INVALID_REPLAY_MANIFEST",label+" 節點識別不正確。");
  return keys;
}
function replayOrder(value: unknown, participantCount: number, label: string): number[] {
  if(value==null) return [];
  if(!Array.isArray(value)||value.length>participantCount) throw new ApiError(400,"INVALID_REPLAY_MANIFEST",label+" 順序不正確。");
  const order=value.map((item)=>Math.trunc(Number(item)));
  if(new Set(order).size!==order.length||order.some((index)=>index<1||index>participantCount)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST",label+" 順序不正確。");
  return order;
}
function normalizeReplayManifest(value: unknown): Json {
  if(!value||typeof value!=="object"||Array.isArray(value)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Manifest 不完整。");
  const input=value as Record<string,any>;
  if(Number(input.version)!==1) throw new ApiError(409,"REPLAY_VERSION_UNSUPPORTED","此失敗紀錄的 Replay Manifest 版本已不支援。");
  const rootSeed=asText(input.rootSeed,160); if(!rootSeed) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Seed 不可為空。");
  const complexityLevel=Math.trunc(Number(input.complexityLevel||0)); if(complexityLevel<1||complexityLevel>8) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 難度不正確。");
  const selectedModules=selectedE2EModules(input.selectedModules); if(!selectedModules) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 模組不完整。");
  const participantCount=Math.trunc(Number(input.participantCount||0)); if(participantCount<1||participantCount>10) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 測試人數不正確。");
  const clientConcurrency=Math.trunc(Number(input.clientConcurrency||0)); if(clientConcurrency<1||clientConcurrency>10) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 併發設定不正確。");
  const admin=input.adminScenario&&typeof input.adminScenario==="object"?input.adminScenario:{};
  const adminFingerprint=asText(admin.scenarioFingerprint,40); if(!/^SG1-[0-9a-f]{8}$/i.test(adminFingerprint)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","管理端 Scenario Fingerprint 不正確。");
  const adminScenario={scenarioFingerprint:adminFingerprint,scenarioPath:replayKeyList(admin.scenarioPath,"管理端 Scenario"),randomStateAfterPlan:Number(admin.randomStateAfterPlan||0)>>>0};
  const rawParticipants=Array.isArray(input.participants)?input.participants:[];
  const clientSurfaceKeys=REPLAY_SURFACES.filter((surface)=>selectedModules.includes(surface));
  if(clientSurfaceKeys.length&&rawParticipants.length!==participantCount) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Participant 數量與用戶端模組不一致。");
  if(!clientSurfaceKeys.length&&rawParticipants.length!==0) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","純管理端 Replay 不應包含用戶端 Participant。");
  const seen=new Set<number>();
  const participants=rawParticipants.map((raw:any)=>{
    const index=Math.trunc(Number(raw?.index||0)); if(index<1||index>participantCount||seen.has(index)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Participant 識別不正確。"); seen.add(index);
    const preferredMemberId=asText(raw?.preferredMemberId,80); if(preferredMemberId&&!UUID_RE.test(preferredMemberId)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 測試會員識別不正確。");
    const seed=asText(raw?.seed,160); if(!seed) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Participant Seed 不可為空。");
    const surfacePlan=Array.isArray(raw?.surfacePlan)?raw.surfacePlan.map((item:unknown)=>asText(item,20)):[];
    if(surfacePlan.length!==clientSurfaceKeys.length||new Set(surfacePlan).size!==surfacePlan.length||surfacePlan.some((surface:string)=>!clientSurfaceKeys.includes(surface as any))) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Surface 路徑不正確。");
    const surfaceSource=raw?.surfaces&&typeof raw.surfaces==="object"?raw.surfaces:{};
    const surfaces:Record<string,unknown>={};
    for(const surface of surfacePlan){
      const descriptor=surfaceSource[surface]; if(!descriptor||typeof descriptor!=="object") throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 缺少 "+surface+" Scenario。");
      const fingerprint=asText(descriptor.scenarioFingerprint,40); if(!/^SG1-[0-9a-f]{8}$/i.test(fingerprint)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST",surface+" Scenario Fingerprint 不正確。");
      const adaptive=descriptor.adaptiveReplaySourceKeys==null?[]:(Array.isArray(descriptor.adaptiveReplaySourceKeys)?descriptor.adaptiveReplaySourceKeys.map((item:unknown)=>asText(item,120)):[]);
      if(adaptive.length>3||adaptive.some((key:string)=>!/^[A-Z0-9_]+$/.test(key))) throw new ApiError(400,"INVALID_REPLAY_MANIFEST",surface+" Adaptive Replay 不正確。");
      surfaces[surface]={scenarioFingerprint:fingerprint,scenarioPath:replayKeyList(descriptor.scenarioPath,surface+" Scenario"),adaptiveReplaySourceKeys:adaptive,randomStateAfterBuild:Number(descriptor.randomStateAfterBuild||0)>>>0,runnerVersion:asText(descriptor.runnerVersion,60)};
    }
    return {index,preferredMemberId,seed,surfacePlan,surfaces};
  });
  const participantExecutionOrder=replayOrder(input.participantExecutionOrder,participantCount,"Participant Execution");
  const syncOrder=replayOrder(input.syncOrder,participantCount,"Participant Sync");
  if(rawParticipants.length&&(participantExecutionOrder.length!==rawParticipants.length||syncOrder.length!==rawParticipants.length)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay Participant 執行順序不完整。");
  const deepParticipantIndex=input.deepParticipantIndex==null?null:Math.trunc(Number(input.deepParticipantIndex));
  if(deepParticipantIndex!=null&&(deepParticipantIndex<1||deepParticipantIndex>participantCount)) throw new ApiError(400,"INVALID_REPLAY_MANIFEST","Replay 深度測試 Participant 不正確。");
  return {version:1,runnerVersion:asText(input.runnerVersion,60),scenarioGraphVersion:Math.max(1,Math.trunc(Number(input.scenarioGraphVersion||1))),rootSeed,complexityLevel,selectedModules,participantCount,clientConcurrency,mobileViewport:input.mobileViewport===true,participantExecutionOrder,syncOrder,deepParticipantIndex,adminScenario,participants};
}
function replaySettingsMatch(source:any,current:any):boolean {
  return String(source?.rootSeed||"")===String(current?.rootSeed||"") &&
    Number(source?.complexityLevel||0)===Number(current?.complexityLevel||0) &&
    Number(source?.participantCount||0)===Number(current?.participantCount||0) &&
    Number(source?.clientConcurrency||0)===Number(current?.clientConcurrency||0) &&
    Boolean(source?.mobileViewport)===Boolean(current?.mobileViewport) &&
    JSON.stringify(source?.selectedModules||[])===JSON.stringify(current?.selectedModules||[]) &&
    JSON.stringify(source?.adminScenario?.scenarioPath||[])===JSON.stringify(current?.adminScenario?.scenarioPath||[]);
}
async function replaySourceRun(supabase:any,runId:string):Promise<{row:any;manifest:Json}> {
  if(!UUID_RE.test(runId)) throw new ApiError(400,"INVALID_RUN_ID","測試執行識別不正確。");
  const result=await supabase.from("automation_test_runs").select("*").eq("id",runId).maybeSingle();
  if(result.error) throw new ApiError(503,"TEST_RUN_READ_FAILED","目前無法讀取失敗測試紀錄。");
  const row=result.data; if(!row) throw new ApiError(404,"TEST_RUN_NOT_FOUND","找不到指定的失敗測試紀錄。");
  const summary=row.summary&&typeof row.summary==="object"?row.summary:{};
  if(row.environment!=="MemberWebsocket-dev"||row.suite!=="full"||row.status!=="failed"||summary.rootRun!==true||summary.runnerKind!=="paired-browser") throw new ApiError(409,"RUN_NOT_REPLAYABLE","只有失敗的完整管理端 ↔ 用戶端 Root E2E 可以一鍵重播。");
  if(!summary.replayManifest) throw new ApiError(409,"REPLAY_MANIFEST_MISSING","此舊測試紀錄尚未保存 Replay Manifest，無法精準一鍵重播。");
  return {row,manifest:normalizeReplayManifest(summary.replayManifest)};
}
function replayComparison(sourceRow:any,currentDiagnostics:any):Json {
  const source=Object.keys(sourceRow?.summary?.failureDiagnostics?.fingerprints||{}).sort();
  const current=Object.keys(currentDiagnostics?.fingerprints||{}).sort();
  const sourceSet=new Set(source), currentSet=new Set(current);
  const reproduced=source.filter((item)=>currentSet.has(item));
  const resolved=source.filter((item)=>!currentSet.has(item));
  const introduced=current.filter((item)=>!sourceSet.has(item));
  return {version:1,verdict:current.length===0?"resolved":reproduced.length?"reproduced":"changed",sourceFingerprints:source,currentFingerprints:current,reproduced,resolved,introduced};
}

function caseDefinitions(suite: string, selectedModules: string[] | null = null): Array<{ key: string; name: string; domain: string }> {
  const quick = [
    { key: "ENVIRONMENT_ACCESS", name: "測試環境可用性", domain: "Environment" },
    { key: "TEST_ACCOUNT_INTEGRITY", name: "測試會員資料完整性", domain: "Member" },
    { key: "SESSION_SECURITY", name: "測試 Session 安全性", domain: "Authentication" },
    { key: "POINTS_INTEGRITY", name: "集點資料一致性", domain: "Points" },
    { key: "FIXED_TICKET_INTEGRITY", name: "固定／活動票券一致性", domain: "Tickets" },
    { key: "LINE_SUPPRESSION", name: "測試會員 LINE 通知阻擋", domain: "Notification" },
  ];
  const definitions = suite === "quick" ? quick : quick.concat([
    { key: "MEMBERSHIP_TERMS_READY", name: "會員條款 E2E 前置狀態", domain: "Member / Legal" },
    { key: "BOOKING_INTEGRITY", name: "預約與技師時段一致性", domain: "Booking" },
    { key: "BOOKING_CONFIRMATION_LINE", name: "預約確認 LINE production contract／正式預約 preview", domain: "Booking / Notification" },
    { key: "PRESENCE_INTEGRITY", name: "會員上線狀態一致性", domain: "Presence" },
  ]);
  if (!selectedModules) return definitions;
  const owners: Record<string, string[]> = {
    MEMBERSHIP_TERMS_READY: ["member"],
    POINTS_INTEGRITY: ["points"],
    FIXED_TICKET_INTEGRITY: ["points", "event"],
    BOOKING_INTEGRITY: ["booking"],
    BOOKING_CONFIRMATION_LINE: ["booking"],
    PRESENCE_INTEGRITY: ["member"],
  };
  return definitions.filter((definition) => !owners[definition.key] || owners[definition.key].some((key) => selectedModules.includes(key)));
}

function runClient(row: any): Json {
  return {
    id: row.id,
    runCode: row.run_code,
    suite: row.suite,
    environment: row.environment,
    status: row.status,
    totalCases: Number(row.total_cases || 0),
    passedCases: Number(row.passed_cases || 0),
    failedCases: Number(row.failed_cases || 0),
    skippedCases: Number(row.summary?.skippedCases || 0),
    summary: row.summary || {},
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stepClient(row: any): Json {
  return {
    id: row.id,
    order: Number(row.step_order || 0),
    key: row.step_key,
    name: row.name,
    status: row.status,
    expected: row.expected ?? {},
    actual: row.actual ?? {},
    message: row.message || "",
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
  };
}

function caseClient(row: any, steps: any[]): Json {
  return {
    id: row.id,
    order: Number(row.case_order || 0),
    key: row.case_key,
    name: row.name,
    domain: row.domain,
    memberId: row.member_id || null,
    status: row.status,
    failureCode: row.failure_code || "",
    failureMessage: row.failure_message || "",
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    steps: steps.map(stepClient),
  };
}

async function runView(supabase: any, runId: string): Promise<Json> {
  const runResult = await supabase
    .from("automation_test_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (runResult.error) throw new ApiError(503, "TEST_RUN_READ_FAILED", "目前無法讀取測試執行紀錄。");
  if (!runResult.data) throw new ApiError(404, "TEST_RUN_NOT_FOUND", "找不到指定的測試執行紀錄。");

  const casesResult = await supabase
    .from("automation_test_cases")
    .select("*")
    .eq("run_id", runId)
    .order("case_order", { ascending: true });
  if (casesResult.error) throw new ApiError(503, "TEST_CASE_READ_FAILED", "目前無法讀取測試案例。");
  const cases = casesResult.data || [];
  const caseIds = cases.map((row: any) => row.id);

  let steps: any[] = [];
  if (caseIds.length) {
    const stepsResult = await supabase
      .from("automation_test_steps")
      .select("*")
      .in("case_id", caseIds)
      .order("step_order", { ascending: true });
    if (stepsResult.error) throw new ApiError(503, "TEST_STEP_READ_FAILED", "目前無法讀取測試步驟。");
    steps = stepsResult.data || [];
  }

  const byCase = new Map<string, any[]>();
  for (const step of steps) {
    const list = byCase.get(step.case_id) || [];
    list.push(step);
    byCase.set(step.case_id, list);
  }

  return {
    run: runClient(runResult.data),
    cases: cases.map((row: any) => caseClient(row, byCase.get(row.id) || [])),
  };
}

async function e2eProfile(supabase: any): Promise<Json> {
  const [stateResult, historyResult, surfaceCaseResult, caseLearningResult] = await Promise.all([
    supabase
      .from("e2e_evolution_state")
      .select("run_count,last_complexity_level,last_seed,last_root_run_id,updated_at")
      .eq("id", true)
      .maybeSingle(),
    supabase
      .from("automation_test_runs")
      .select("summary,created_at,status")
      .eq("environment", "MemberWebsocket-dev")
      .eq("suite", "full")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("automation_test_cases")
      .select("case_key,duration_ms,status,created_at")
      .like("case_key", "PAIRED_%")
      .eq("status", "passed")
      .not("duration_ms", "is", null)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("e2e_case_learning_state")
      .select("case_key,executions,pass_count,fail_count,skip_count,failure_rate,failure_ewma,flaky_score,avg_duration_ms,p95_duration_ms,risk_score,preferred_tester_profile,profile_stats,last_status,last_failure_code,last_failure_fingerprint,last_failed_at,last_passed_at,updated_at")
      .order("risk_score", { ascending: false })
      .limit(500),
  ]);
  if (stateResult.error || historyResult.error) {
    throw new ApiError(503, "E2E_PROFILE_READ_FAILED", "目前無法讀取 E2E 複雜度歷史。");
  }

  const fallbackWeights: Record<string, number> = {
    member: 1000,
    points: 1300,
    event: 1200,
    calendar: 1100,
    booking: 2200,
  };
  const durationBuckets: Record<string, number[]> = {
    member: [],
    points: [],
    event: [],
    calendar: [],
    booking: [],
  };
  if (!surfaceCaseResult.error) {
    for (const row of surfaceCaseResult.data || []) {
      const match = /^PAIRED_\d+_(MEMBER|POINTS|EVENT|CALENDAR|BOOKING)$/.exec(asText(row?.case_key, 120));
      if (!match) continue;
      const key = match[1].toLowerCase();
      const duration = Math.max(1, Number(row?.duration_ms || 0) || 0);
      if (duration > 0 && durationBuckets[key].length < 80) durationBuckets[key].push(duration);
    }
  }
  const surfaceWeightsMs: Record<string, number> = {};
  const surfaceSamples: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(fallbackWeights)) {
    const values = durationBuckets[key].slice().sort((a, b) => a - b);
    surfaceSamples[key] = values.length;
    if (!values.length) {
      surfaceWeightsMs[key] = fallback;
      continue;
    }
    const middle = Math.floor(values.length / 2);
    surfaceWeightsMs[key] = Math.round(
      values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    );
  }

  const caseLearning: Record<string, Json> = {};
  if (!caseLearningResult.error) {
    for (const row of caseLearningResult.data || []) {
      const key = asText(row?.case_key, 120);
      if (!key) continue;
      caseLearning[key] = {
        executions: Math.max(0, Number(row.executions || 0)),
        passCount: Math.max(0, Number(row.pass_count || 0)),
        failCount: Math.max(0, Number(row.fail_count || 0)),
        skipCount: Math.max(0, Number(row.skip_count || 0)),
        failureRate: Math.max(0, Math.min(1, Number(row.failure_rate || 0))),
        failureEwma: Math.max(0, Math.min(1, Number(row.failure_ewma || 0))),
        flakyScore: Math.max(0, Math.min(1, Number(row.flaky_score || 0))),
        avgDurationMs: Math.max(0, Number(row.avg_duration_ms || 0)),
        p95DurationMs: Math.max(0, Number(row.p95_duration_ms || 0)),
        riskScore: Math.max(0, Math.min(1, Number(row.risk_score || 0))),
        preferredTesterProfile: asText(row.preferred_tester_profile, 40),
        profileStats: row.profile_stats && typeof row.profile_stats === "object" ? row.profile_stats : {},
        lastStatus: asText(row.last_status, 20),
        lastFailureCode: asText(row.last_failure_code, 120),
        lastFailureFingerprint: asText(row.last_failure_fingerprint, 80),
        lastFailedAt: row.last_failed_at || null,
        lastPassedAt: row.last_passed_at || null,
        updatedAt: row.updated_at || null,
      };
    }
  }

  const rootRuns = (historyResult.data || []).filter((row: any) => row?.summary?.rootRun === true);
  const durableRunCount = Math.max(0, Number(stateResult.data?.run_count || 0) || 0);
  const completedRootRuns = Math.max(durableRunCount, rootRuns.length);
  const last = rootRuns[0] || null;
  const nextComplexityLevel = Math.max(1, Math.min(8, completedRootRuns + 1));
  return {
    completedRootRuns,
    durableRunCount,
    nextComplexityLevel,
    maxComplexityLevel: 8,
    previousSeed: asText(stateResult.data?.last_seed || last?.summary?.e2eSeed, 160),
    previousComplexityLevel: Math.max(0, Number(stateResult.data?.last_complexity_level || last?.summary?.complexityLevel || 0) || 0),
    previousRootRunId: asText(stateResult.data?.last_root_run_id, 80),
    previousStatus: asText(last?.status, 40),
    evolutionUpdatedAt: stateResult.data?.updated_at || null,
    surfaceWeightsMs,
    surfaceSamples,
    learningAvailable: !caseLearningResult.error,
    caseLearning,
  };
}

async function recentRuns(supabase: any): Promise<Json[]> {
  const result = await supabase
    .from("automation_test_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(12);
  if (result.error) throw new ApiError(503, "TEST_HISTORY_READ_FAILED", "目前無法讀取歷史測試紀錄。");
  return (result.data || []).map(runClient);
}

// Edge requests have a bounded lifetime. If a worker exits during a backend
// suite, its database rows otherwise remain "running" and block QA cleanup.
// Five minutes is longer than a single Edge request, and no active run can be
// mistaken for an abandoned one merely because the browser polling paused.
async function expireAbandonedRuns(supabase: any): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const candidates = await supabase.from("automation_test_runs")
    .select("id,status,summary,started_at,updated_at")
    .eq("environment", "MemberWebsocket-dev")
    .in("status", ["queued", "running"])
    .lt("updated_at", cutoff)
    .limit(20);
  if (candidates.error) throw new ApiError(503, "STALE_RUN_READ_FAILED", "無法檢查逾時測試紀錄。");

  for (const run of candidates.data || []) {
    const now = new Date().toISOString();
    const pending = await supabase.from("automation_test_cases").update({
      status: "failed",
      failure_code: "E2E_RUN_ABANDONED",
      failure_message: "後端 Runner 中斷或逾時；此案例未能完成驗證。",
      completed_at: now,
      updated_at: now,
    }).eq("run_id", run.id).in("status", ["queued", "running"]);
    if (pending.error) throw new ApiError(503, "STALE_CASE_RECOVERY_FAILED", "無法標記中斷測試案例。");

    const cases = await supabase.from("automation_test_cases").select("status").eq("run_id", run.id);
    if (cases.error) throw new ApiError(503, "STALE_RUN_COUNT_FAILED", "無法統計中斷測試結果。");
    const rows = cases.data || [];
    const summary = run.summary && typeof run.summary === "object" ? run.summary : {};
    const completed = await supabase.from("automation_test_runs").update({
      status: "failed",
      total_cases: rows.length,
      passed_cases: rows.filter((row: any) => row.status === "passed").length,
      failed_cases: rows.filter((row: any) => row.status === "failed").length,
      summary: { ...summary, abandoned: true, failureCode: "E2E_RUN_ABANDONED" },
      completed_at: now,
      updated_at: now,
    }).eq("id", run.id).in("status", ["queued", "running"]).lt("updated_at", cutoff);
    if (completed.error) throw new ApiError(503, "STALE_RUN_RECOVERY_FAILED", "無法結束中斷測試紀錄。");
  }
}

async function testMembers(supabase: any): Promise<any[]> {
  const result = await supabase
    .from("members")
    .select("id,line_user_id,display_name,member_code,status,membership_status,birthday,phone,surname,salutation")
    .eq("is_test_account", true)
    .order("test_account_sequence", { ascending: true, nullsFirst: false });
  if (result.error) throw new ApiError(503, "TEST_MEMBER_READ_FAILED", "目前無法讀取測試會員資料。");
  return result.data || [];
}

function pass(message: string, expected: unknown, actual: unknown): CaseResult {
  return { passed: true, code: "", message, expected, actual };
}

function fail(code: string, message: string, expected: unknown, actual: unknown): CaseResult {
  return { passed: false, skipped: false, code, message, expected, actual };
}

function skip(code: string, message: string, expected: unknown, actual: unknown): CaseResult {
  return { passed: false, skipped: true, code, message, expected, actual };
}

async function evaluateEnvironment(supabase: any): Promise<CaseResult> {
  const [settingsResult, memberCountResult] = await Promise.all([
    supabase
      .from("test_mode_settings")
      .select("maintenance_enabled,allow_pc_test_login,allow_mobile_test_login,updated_at")
      .eq("id", true)
      .maybeSingle(),
    supabase
      .from("members")
      .select("*", { count: "exact", head: true })
      .eq("is_test_account", true)
      .eq("status", "active")
      .eq("membership_status", "active"),
  ]);
  if (settingsResult.error || memberCountResult.error) {
    throw new ApiError(503, "ENVIRONMENT_READ_FAILED", "無法讀取測試環境狀態。");
  }

  const row = settingsResult.data;
  const settingsRowPresent = Boolean(row);
  const flagsAreBoolean = Boolean(
    row &&
    typeof row.maintenance_enabled === "boolean" &&
    typeof row.allow_pc_test_login === "boolean" &&
    typeof row.allow_mobile_test_login === "boolean"
  );
  const actual = {
    settingsRowPresent,
    settingsFlagsValid: flagsAreBoolean,
    maintenanceEnabled: row?.maintenance_enabled === true,
    pcLoginEnabled: row?.allow_pc_test_login === true,
    mobileLoginEnabled: row?.allow_mobile_test_login === true,
    activeTestAccounts: Number(memberCountResult.count || 0),
    updatedAt: row?.updated_at || null,
    note: "自動化 Runner 使用管理端 server-side 權限；維護模式與裝置測試登入開關可為關閉。",
  };
  const expected = {
    settingsRowPresent: true,
    settingsFlagsValid: true,
    activeTestAccountsAtLeast: 1,
  };
  const ok = settingsRowPresent && flagsAreBoolean && actual.activeTestAccounts >= 1;
  return ok
    ? pass("測試設定可讀，且存在可用測試會員；維護模式與裝置登入開關不影響 server-side 自動化測試。", expected, actual)
    : fail("TEST_ENVIRONMENT_NOT_READY", "測試設定不存在、欄位格式異常，或沒有可用測試會員。", expected, actual);
}

async function evaluateMembershipTerms(supabase: any): Promise<CaseResult> {
  const nowMs = Date.now();
  const result = await supabase
    .from("membership_terms")
    .select("id,version,title,status,required,effective_at,activated_at")
    .eq("status", "active")
    .eq("required", true)
    .order("activated_at", { ascending: false, nullsFirst: false })
    .limit(5);
  if (result.error) throw new ApiError(503, "MEMBERSHIP_TERMS_READ_FAILED", "目前無法讀取會員條款前置狀態。");

  const configured = result.data || [];
  const eligible = configured.filter((row: any) => {
    if (!row.effective_at) return true;
    const effectiveMs = new Date(row.effective_at).getTime();
    return Number.isFinite(effectiveMs) && effectiveMs <= nowMs;
  });
  const active = eligible[0] || null;
  const actual = {
    configuredActiveRequiredTerms: configured.length,
    activeRequiredTerms: eligible.length,
    activeVersion: active?.version || null,
    effectiveAt: active?.effective_at || null,
    activatedAt: active?.activated_at || null,
  };
  const expected = { activeRequiredTermsAtLeast: 1 };
  return active
    ? pass("會員模組 E2E 已確認存在目前生效且需同意的會員條款。", expected, actual)
    : skip(
        "MEMBERSHIP_TERMS_NOT_CONFIGURED",
        "目前沒有已啟用且已生效的必須同意會員條款；此案例略過，不計為功能回歸。",
        expected,
        { ...actual, coverageState: "blocked" },
      );
}

async function evaluateTestAccounts(supabase: any): Promise<CaseResult> {
  const rows = await testMembers(supabase);
  const today = new Date().toISOString().slice(0, 10);
  const invalid: string[] = [];
  let active = 0;
  for (const row of rows) {
    if (row.status === "active" && row.membership_status === "active") active += 1;
    const phone = asText(row.phone, 30).replace(/[()\s-]/g, "");
    const profileOk = Boolean(
      row.status === "active" &&
      row.membership_status === "active" &&
      row.birthday &&
      String(row.birthday) <= today &&
      /^\+?\d{8,15}$/.test(phone) &&
      asText(row.surname, 40) &&
      ["mr", "ms"].includes(asText(row.salutation, 10).toLowerCase()),
    );
    if (!profileOk && invalid.length < 5) invalid.push(asText(row.member_code, 30) || row.id);
  }
  const actual = {
    totalTestAccounts: rows.length,
    activeTestAccounts: active,
    invalidProfileCount: rows.length - active + Math.max(0, invalid.length - (rows.length - active)),
    sampleInvalidMemberCodes: invalid,
  };
  const invalidCount = rows.filter((row: any) => {
    const phone = asText(row.phone, 30).replace(/[()\s-]/g, "");
    return !(
      row.status === "active" &&
      row.membership_status === "active" &&
      row.birthday &&
      String(row.birthday) <= today &&
      /^\+?\d{8,15}$/.test(phone) &&
      asText(row.surname, 40) &&
      ["mr", "ms"].includes(asText(row.salutation, 10).toLowerCase())
    );
  }).length;
  actual.invalidProfileCount = invalidCount;
  const expected = { totalTestAccountsAtLeast: 1, invalidProfileCount: 0 };
  return rows.length > 0 && invalidCount === 0
    ? pass("測試會員皆具備可用且合法的個人資料。", expected, actual)
    : fail("TEST_ACCOUNT_PROFILE_INVALID", "部分測試會員資料不完整或不符合驗證規則。", expected, actual);
}

async function evaluateSessions(supabase: any): Promise<CaseResult> {
  const members = await testMembers(supabase);
  const memberIds = new Set(members.map((row: any) => row.id));
  const result = await supabase
    .from("test_login_sessions")
    .select("id,token_hash,member_id,expires_at,revoked_at,device_class");
  if (result.error) throw new ApiError(503, "TEST_SESSION_READ_FAILED", "無法讀取測試登入 Session。");

  const rows = result.data || [];
  const now = Date.now();
  let invalidHash = 0;
  let nonTestMember = 0;
  let invalidActiveDevice = 0;
  let activeSessions = 0;
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(asText(row.token_hash, 80))) invalidHash += 1;
    if (!memberIds.has(row.member_id)) nonTestMember += 1;
    const active = !row.revoked_at && new Date(row.expires_at).getTime() > now;
    if (active) {
      activeSessions += 1;
      if (!["pc", "mobile"].includes(asText(row.device_class, 10))) invalidActiveDevice += 1;
    }
  }
  const actual = {
    totalSessionRows: rows.length,
    activeSessions,
    invalidTokenHashRows: invalidHash,
    sessionsLinkedToNonTestMember: nonTestMember,
    activeSessionsWithInvalidDeviceClass: invalidActiveDevice,
  };
  const expected = {
    invalidTokenHashRows: 0,
    sessionsLinkedToNonTestMember: 0,
    activeSessionsWithInvalidDeviceClass: 0,
  };
  const ok = invalidHash === 0 && nonTestMember === 0 && invalidActiveDevice === 0;
  return ok
    ? pass("測試 Session token hash、會員綁定與裝置類型皆符合安全規則。", expected, actual)
    : fail("TEST_SESSION_INVARIANT_FAILED", "測試 Session 存在不符合安全規則的資料。", expected, actual);
}

async function evaluatePoints(supabase: any): Promise<CaseResult> {
  const members = await testMembers(supabase);
  const ids = members.map((row: any) => row.id);
  if (!ids.length) return fail("NO_TEST_ACCOUNTS", "沒有可驗證的測試會員。", { testAccountsAtLeast: 1 }, { testAccounts: 0 });

  const [balanceResult, entryResult, ticketResult] = await Promise.all([
    supabase.from("point_balances").select("member_id,point_card_id,stamps").in("member_id", ids),
    supabase.from("point_entries").select("member_id,point_card_id,amount").in("member_id", ids),
    supabase.from("point_tickets").select("id,status,member_id,points_spent").in("member_id", ids),
  ]);
  if (balanceResult.error || entryResult.error || ticketResult.error) {
    throw new ApiError(503, "POINT_DATA_READ_FAILED", "無法讀取測試會員集點資料。");
  }

  const balances = balanceResult.data || [];
  const entries = entryResult.data || [];
  const tickets = ticketResult.data || [];
  const sums = new Map<string, number>();
  for (const row of entries) {
    const key = row.member_id + "|" + row.point_card_id;
    sums.set(key, (sums.get(key) || 0) + Number(row.amount || 0));
  }
  const balanceMap = new Map<string, number>();
  let negativeBalances = 0;
  for (const row of balances) {
    const key = row.member_id + "|" + row.point_card_id;
    const value = Number(row.stamps || 0);
    balanceMap.set(key, value);
    if (value < 0) negativeBalances += 1;
  }
  const keys = new Set([...sums.keys(), ...balanceMap.keys()]);
  let mismatches = 0;
  for (const key of keys) {
    if ((sums.get(key) || 0) !== (balanceMap.get(key) || 0)) mismatches += 1;
  }
  const invalidTicketSpend = tickets.filter((row: any) => Number(row.points_spent || 0) < 0).length;
  const actual = {
    balanceRows: balances.length,
    entryRows: entries.length,
    ticketRows: tickets.length,
    negativeBalanceRows: negativeBalances,
    derivedBalanceMismatches: mismatches,
    negativeTicketSpendRows: invalidTicketSpend,
  };
  const expected = {
    negativeBalanceRows: 0,
    derivedBalanceMismatches: 0,
    negativeTicketSpendRows: 0,
  };
  const ok = negativeBalances === 0 && mismatches === 0 && invalidTicketSpend === 0;
  return ok
    ? pass("集點餘額與集點流水一致，未發現負數或衍生值錯誤。", expected, actual)
    : fail("POINT_DATA_INCONSISTENT", "集點餘額與集點流水存在不一致。", expected, actual);
}

async function evaluateTickets(supabase: any): Promise<CaseResult> {
  const members = await testMembers(supabase);
  const ids = members.map((row: any) => row.id);
  if (!ids.length) return fail("NO_TEST_ACCOUNTS", "沒有可驗證的測試會員。", { testAccountsAtLeast: 1 }, { testAccounts: 0 });

  const [grantResult, claimResult] = await Promise.all([
    supabase
      .from("fixed_ticket_grants")
      .select("id,fixed_ticket_template_id,member_id,cycle_key,event_ticket_id,claim_id,status")
      .in("member_id", ids),
    supabase
      .from("event_ticket_claims")
      .select("id,claim_id,member_id,event_ticket_id,status")
      .in("member_id", ids),
  ]);
  if (grantResult.error || claimResult.error) {
    throw new ApiError(503, "TICKET_DATA_READ_FAILED", "無法讀取測試會員票券資料。");
  }

  const grants = grantResult.data || [];
  const claims = claimResult.data || [];
  const claimIds = new Set(claims.map((row: any) => asText(row.claim_id, 160)).filter(Boolean));
  const grantKeys = new Set<string>();
  let duplicateGrantCycles = 0;
  let issuedGrantMissingClaim = 0;
  for (const row of grants) {
    const key = row.fixed_ticket_template_id + "|" + row.member_id + "|" + row.cycle_key;
    if (grantKeys.has(key)) duplicateGrantCycles += 1;
    grantKeys.add(key);
    if (row.status === "issued") {
      if (!row.event_ticket_id || !row.claim_id || !claimIds.has(asText(row.claim_id, 160))) {
        issuedGrantMissingClaim += 1;
      }
    }
  }
  const actual = {
    fixedTicketGrantRows: grants.length,
    eventTicketClaimRows: claims.length,
    duplicateGrantCycles,
    issuedGrantMissingClaim,
  };
  const expected = { duplicateGrantCycles: 0, issuedGrantMissingClaim: 0 };
  const ok = duplicateGrantCycles === 0 && issuedGrantMissingClaim === 0;
  return ok
    ? pass("固定票券發放與活動票券 Claim 關聯一致。", expected, actual)
    : fail("TICKET_LINK_INCONSISTENT", "固定票券或活動票券關聯存在異常。", expected, actual);
}

async function evaluateBooking(supabase: any): Promise<CaseResult> {
  const members = await testMembers(supabase);
  const ids = members.map((row: any) => row.id);
  if (!ids.length) return fail("NO_TEST_ACCOUNTS", "沒有可驗證的測試會員。", { testAccountsAtLeast: 1 }, { testAccounts: 0 });

  const bookingResult = await supabase
    .from("bookings")
    .select("id,booking_date,start_time,end_time,status,total_duration_minutes,technician_id")
    .in("member_id", ids);
  if (bookingResult.error) throw new ApiError(503, "BOOKING_READ_FAILED", "無法讀取測試會員預約資料。");
  const bookings = bookingResult.data || [];
  const bookingIds = bookings.map((row: any) => row.id);

  let reservations: any[] = [];
  if (bookingIds.length) {
    const reservationResult = await supabase
      .from("booking_participant_reservations")
      .select("participant_id,booking_id,technician_id,booking_date,start_time,end_time,is_active")
      .in("booking_id", bookingIds);
    if (reservationResult.error) throw new ApiError(503, "BOOKING_RESERVATION_READ_FAILED", "無法讀取預約技師時段。");
    reservations = reservationResult.data || [];
  }

  let invalidDurationRows = 0;
  for (const row of bookings) {
    if (!row.start_time || !row.end_time || String(row.start_time) >= String(row.end_time) || Number(row.total_duration_minutes || 0) <= 0) {
      invalidDurationRows += 1;
    }
  }

  const active = reservations.filter((row: any) => row.is_active === true);
  const groups = new Map<string, any[]>();
  for (const row of active) {
    const key = row.technician_id + "|" + row.booking_date;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  let overlappingReservations = 0;
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (String(list[j].start_time) >= String(list[i].end_time)) break;
        if (
          list[i].booking_id !== list[j].booking_id &&
          String(list[i].start_time) < String(list[j].end_time) &&
          String(list[j].start_time) < String(list[i].end_time)
        ) {
          overlappingReservations += 1;
        }
      }
    }
  }

  const actual = {
    bookingRows: bookings.length,
    activeParticipantReservations: active.length,
    invalidDurationRows,
    overlappingTechnicianReservations: overlappingReservations,
  };
  const expected = { invalidDurationRows: 0, overlappingTechnicianReservations: 0 };
  const ok = invalidDurationRows === 0 && overlappingReservations === 0;
  return ok
    ? pass("測試會員預約時間與技師占用時段沒有衝突。", expected, actual)
    : fail("BOOKING_INVARIANT_FAILED", "預約時間或技師占用時段存在資料異常。", expected, actual);
}

async function evaluatePresence(supabase: any): Promise<CaseResult> {
  const members = await testMembers(supabase);
  const ids = members.map((row: any) => row.id);
  if (!ids.length) return fail("NO_TEST_ACCOUNTS", "沒有可驗證的測試會員。", { testAccountsAtLeast: 1 }, { testAccounts: 0 });

  const result = await supabase
    .from("member_presence_sessions")
    .select("id,member_id,surface,last_seen_at,offline_at")
    .in("member_id", ids)
    .is("offline_at", null);
  if (result.error) throw new ApiError(503, "PRESENCE_READ_FAILED", "無法讀取測試會員上線狀態。");

  const rows = result.data || [];
  // Presence is lease/heartbeat based. A pagehide keepalive request is best-effort and
  // may be dropped by the browser, so offline_at=null alone must not mean "online".
  // Keep this threshold aligned with the active-presence semantics used by test-mode-api.
  const activeThresholdMs = 90 * 1000;
  const now = Date.now();
  const invalidTimestampRows = rows.filter((row: any) => !Number.isFinite(new Date(row.last_seen_at).getTime()));
  const fresh = rows.filter((row: any) => {
    const lastSeen = new Date(row.last_seen_at).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen <= activeThresholdMs;
  });
  const stale = rows.filter((row: any) => {
    const lastSeen = new Date(row.last_seen_at).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen > activeThresholdMs;
  });
  const actual = {
    openStorageRows: rows.length,
    effectiveActivePresenceSessions: fresh.length,
    staleStorageRows: stale.length,
    invalidTimestampRows: invalidTimestampRows.length,
    activeThresholdSeconds: activeThresholdMs / 1000,
    activeSurfaces: [...new Set(fresh.map((row: any) => asText(row.surface, 30)).filter(Boolean))],
    note: "staleStorageRows are expired heartbeat leases and are not treated as online",
  };
  const expected = { invalidTimestampRows: 0 };
  return invalidTimestampRows.length === 0
    ? pass("Presence 以 90 秒心跳租約判定；過期但尚未寫 offline_at 的殘留 row 不再誤判為在線。", expected, actual)
    : fail("PRESENCE_TIMESTAMP_INVALID", "Presence session 存在無法解析的心跳時間。", expected, actual);
}

async function evaluateBookingConfirmationLine(supabase: any): Promise<CaseResult> {
  const config = await supabase.rpc("booking_notification_config");
  if (config.error) {
    throw new ApiError(503, "BOOKING_NOTIFICATION_CONFIG_FAILED", "無法讀取預約通知測試設定。");
  }
  const secret = asText(config.data?.BOOKING_NOTIFICATION_DISPATCH_SECRET, 200);
  const baseUrl = env("SUPABASE_URL");
  if (!baseUrl || !secret) {
    throw new ApiError(503, "BOOKING_NOTIFICATION_CONFIG_MISSING", "預約通知測試設定尚未完成。");
  }

  let remote: Response;
  try {
    remote = await fetch(baseUrl + "/functions/v1/booking-line-notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dispatch-secret": secret,
      },
      body: JSON.stringify({ action: "self-test-confirmation" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(503, "BOOKING_NOTIFICATION_SELF_TEST_UNAVAILABLE", "預約確認 LINE self-test 暫時無法連線。");
  }

  let payload: any = {};
  try {
    payload = await remote.json();
  } catch {
    throw new ApiError(503, "BOOKING_NOTIFICATION_SELF_TEST_INVALID", "預約確認 LINE self-test 回應格式不正確。");
  }

  const data = payload?.data || {};
  const actual = {
    httpStatus: remote.status,
    productionContract: data.productionContract === true,
    contractSource: asText(data.contractSource, 40),
    productionMember: data.productionMember === true,
    flexType: asText(data.productionPreview?.flexType, 20),
    altTextPresent: data.productionPreview?.altTextPresent === true,
    pointTicketCount: Number(data.productionPreview?.pointTicketCount || 0),
    eventTicketCount: Number(data.productionPreview?.eventTicketCount || 0),
    tierActivityCount: Number(data.productionPreview?.tierActivityCount || 0),
    tierLabel: asText(data.productionPreview?.tierLabel, 40),
    emptyEntitlementSections: Number(data.emptyEntitlements?.emptyStateSections || 0),
    emptyEntitlementsPassed: data.emptyEntitlements?.passed === true,
    expiredExclusionPassed: data.expiredExclusion?.passed === true,
    retryFirstRetryable: data.retrySemantics?.firstRetryable === true,
    retryAccepted: data.retrySemantics?.retryAccepted === true,
    retryKeyStable: data.retrySemantics?.retryKeyStable === true,
    retrySemanticsPassed: data.retrySemantics?.passed === true,
  };
  const expected = {
    httpStatus: 200,
    productionContract: true,
    contractSource: "live-preview | synthetic-contract",
    flexType: "flex",
    altTextPresent: true,
    emptyEntitlementSections: 0,
    emptyEntitlementsPassed: true,
    expiredExclusionPassed: true,
    retryFirstRetryable: true,
    retryAccepted: true,
    retryKeyStable: true,
    retrySemanticsPassed: true,
  };
  const ok = remote.ok
    && payload?.ok === true
    && actual.productionContract
    && ["live-preview", "synthetic-contract"].includes(actual.contractSource)
    && actual.flexType === "flex"
    && actual.altTextPresent
    && actual.emptyEntitlementSections === 0
    && actual.emptyEntitlementsPassed
    && actual.expiredExclusionPassed
    && actual.retryFirstRetryable
    && actual.retryAccepted
    && actual.retryKeyStable
    && actual.retrySemanticsPassed;

  return ok
    ? pass(
        actual.productionMember
          ? "正式預約 preview 與 LINE production contract、空狀態、過期排除及冪等重試皆通過。"
          : "目前沒有正式預約 preview；已用無副作用 synthetic contract 驗證 LINE production renderer、空狀態、過期排除與冪等重試。",
        expected,
        actual,
      )
    : fail("BOOKING_CONFIRMATION_LINE_FAILED", "預約確認 LINE production contract self-test 未通過。", expected, actual);
}

async function evaluateLineSuppression(supabase: any): Promise<CaseResult> {
  const rpc = await supabase.rpc("automation_test_notification_snapshot");
  if (rpc.error) throw new ApiError(503, "NOTIFICATION_SNAPSHOT_FAILED", "無法讀取測試會員通知佇列。");
  const actual = rpc.data || {};
  const scheduled = Number(actual.scheduledGrantMessages || 0);
  const bookingOutbox = Number(actual.bookingOutboxMessages || 0);
  const testRecipientOutbox = Number(actual.testRecipientOutboxMessages || 0);
  const normalized = {
    scheduledGrantMessages: scheduled,
    bookingOutboxMessages: bookingOutbox,
    testRecipientOutboxMessages: testRecipientOutbox,
  };
  const expected = {
    scheduledGrantMessages: 0,
    bookingOutboxMessages: 0,
    testRecipientOutboxMessages: 0,
  };
  const ok = scheduled === 0 && bookingOutbox === 0 && testRecipientOutbox === 0;
  return ok
    ? pass("測試會員沒有建立任何 LINE 發送佇列。", expected, normalized)
    : fail("TEST_MEMBER_LINE_QUEUE_DETECTED", "測試會員出現 LINE 發送佇列，需立即檢查通知邊界。", expected, normalized);
}

async function evaluateCase(supabase: any, caseKey: string): Promise<CaseResult> {
  if (caseKey === "ENVIRONMENT_ACCESS") return evaluateEnvironment(supabase);
  if (caseKey === "TEST_ACCOUNT_INTEGRITY") return evaluateTestAccounts(supabase);
  if (caseKey === "MEMBERSHIP_TERMS_READY") return evaluateMembershipTerms(supabase);
  if (caseKey === "SESSION_SECURITY") return evaluateSessions(supabase);
  if (caseKey === "POINTS_INTEGRITY") return evaluatePoints(supabase);
  if (caseKey === "FIXED_TICKET_INTEGRITY") return evaluateTickets(supabase);
  if (caseKey === "LINE_SUPPRESSION") return evaluateLineSuppression(supabase);
  if (caseKey === "BOOKING_INTEGRITY") return evaluateBooking(supabase);
  if (caseKey === "BOOKING_CONFIRMATION_LINE") return evaluateBookingConfirmationLine(supabase);
  if (caseKey === "PRESENCE_INTEGRITY") return evaluatePresence(supabase);
  throw new ApiError(500, "UNKNOWN_TEST_CASE", "自動化測試案例未註冊。");
}

async function insertStep(
  supabase: any,
  caseId: string,
  order: number,
  key: string,
  name: string,
  status: string,
  expected: unknown,
  actual: unknown,
  message: string,
  startedAt: string,
  durationMs: number,
): Promise<void> {
  const now = new Date().toISOString();
  const result = await supabase.from("automation_test_steps").insert({
    case_id: caseId,
    step_order: order,
    step_key: key,
    name,
    status,
    expected,
    actual,
    message,
    started_at: startedAt,
    completed_at: now,
    duration_ms: Math.max(0, Math.round(durationMs)),
    updated_at: now,
  });
  if (result.error) throw new ApiError(503, "TEST_STEP_WRITE_FAILED", "目前無法寫入測試步驟。");
}

async function executeCase(supabase: any, testCase: any): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const startResult = await supabase
    .from("automation_test_cases")
    .update({
      status: "running",
      started_at: startedAt,
      updated_at: startedAt,
      failure_code: null,
      failure_message: null,
    })
    .eq("id", testCase.id)
    .eq("status", "queued");
  if (startResult.error) throw new ApiError(503, "TEST_CASE_START_FAILED", "目前無法啟動測試案例。");

  try {
    const collectStartedAt = new Date().toISOString();
    const collectMs = Date.now();
    const result = await evaluateCase(supabase, testCase.case_key);
    const caseStatus = result.skipped ? "skipped" : result.passed ? "passed" : "failed";
    await insertStep(
      supabase,
      testCase.id,
      1,
      "collect",
      "收集目前測試數據",
      "passed",
      {},
      result.actual,
      "已取得本案例需要的安全測試快照。",
      collectStartedAt,
      Date.now() - collectMs,
    );
    await insertStep(
      supabase,
      testCase.id,
      2,
      "validate",
      "驗證預期條件",
      caseStatus,
      result.expected,
      result.actual,
      result.message,
      new Date().toISOString(),
      0,
    );

    const completedAt = new Date().toISOString();
    const update = await supabase
      .from("automation_test_cases")
      .update({
        status: caseStatus,
        failure_code: caseStatus === "failed" ? result.code : null,
        failure_message: caseStatus === "failed" ? result.message : null,
        completed_at: completedAt,
        duration_ms: Date.now() - startedMs,
        updated_at: completedAt,
      })
      .eq("id", testCase.id);
    if (update.error) throw new ApiError(503, "TEST_CASE_FINISH_FAILED", "目前無法完成測試案例。");
  } catch (error) {
    const e = error instanceof ApiError
      ? error
      : new ApiError(500, "CASE_EXECUTION_ERROR", "測試案例執行時發生未預期錯誤。");
    try {
      await insertStep(
        supabase,
        testCase.id,
        1,
        "collect",
        "收集目前測試數據",
        "failed",
        {},
        { errorCode: e.code },
        e.message,
        startedAt,
        Date.now() - startedMs,
      );
    } catch {}
    const completedAt = new Date().toISOString();
    await supabase
      .from("automation_test_cases")
      .update({
        status: "failed",
        failure_code: e.code,
        failure_message: e.message,
        completed_at: completedAt,
        duration_ms: Date.now() - startedMs,
        updated_at: completedAt,
      })
      .eq("id", testCase.id);
  }
}

async function refreshCounters(
  supabase: any,
  runId: string,
): Promise<{ total: number; passed: number; failed: number; skipped: number }> {
  const result = await supabase
    .from("automation_test_cases")
    .select("status")
    .eq("run_id", runId);
  if (result.error) throw new ApiError(503, "TEST_COUNTER_READ_FAILED", "無法更新測試進度。");
  const rows = result.data || [];
  const counters = {
    total: rows.length,
    passed: rows.filter((row: any) => row.status === "passed").length,
    failed: rows.filter((row: any) => row.status === "failed").length,
    skipped: rows.filter((row: any) => row.status === "skipped").length,
  };
  const now = new Date().toISOString();
  const update = await supabase
    .from("automation_test_runs")
    .update({
      total_cases: counters.total,
      passed_cases: counters.passed,
      failed_cases: counters.failed,
      updated_at: now,
    })
    .eq("id", runId);
  if (update.error) throw new ApiError(503, "TEST_COUNTER_WRITE_FAILED", "無法更新測試進度。");
  return counters;
}

function browserRunWindow(body: Json): { startedAt: string; completedAt: string; durationMs: number } {
  const requestedStartedAt = asText(body.startedAt, 50);
  const requestedCompletedAt = asText(body.completedAt, 50);
  if (!requestedStartedAt && !requestedCompletedAt) {
    const now = new Date().toISOString();
    return { startedAt: now, completedAt: now, durationMs: 0 };
  }
  const startedMs = Date.parse(requestedStartedAt);
  const completedMs = Date.parse(requestedCompletedAt);
  const nowMs = Date.now();
  if (
    !Number.isFinite(startedMs)
    || !Number.isFinite(completedMs)
    || completedMs < startedMs
    || completedMs > nowMs + 60_000
    || startedMs < nowMs - 6 * 60 * 60 * 1000
  ) {
    throw new ApiError(400, "INVALID_BROWSER_RUN_WINDOW", "瀏覽器 E2E 執行時間範圍不正確。");
  }
  return {
    startedAt: new Date(startedMs).toISOString(),
    completedAt: new Date(completedMs).toISOString(),
    durationMs: completedMs - startedMs,
  };
}

function safeBrowserSnapshot(value: unknown, maxChars = 5000): unknown {
  if (value === undefined) return {};
  let serialized = "";
  try { serialized = JSON.stringify(value ?? {}); }
  catch { throw new ApiError(400, "INVALID_BROWSER_SNAPSHOT", "E2E 測試資料必須可安全序列化。"); }
  if (serialized.length > maxChars) {
    throw new ApiError(413, "BROWSER_SNAPSHOT_TOO_LARGE", "單一 E2E 測試快照過大。");
  }
  try { return JSON.parse(serialized); }
  catch { return {}; }
}

function safeBrowserTraceSnapshot(value: unknown, maxChars = 12_000): unknown {
  const redact = (input: unknown, depth = 0): unknown => {
    if (depth > 6) return "[max-depth]";
    if (input == null || typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input === "string") {
      return input
        .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
        .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
        .slice(0, 1200);
    }
    if (Array.isArray(input)) return input.slice(0, 30).map((item) => redact(item, depth + 1));
    if (typeof input !== "object") return String(input).slice(0, 300);
    const blocked = /token|secret|password|phone|birthday|line.?user.?id|surname|display.?name/i;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>).slice(0, 60)) {
      out[key] = blocked.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  };
  return safeBrowserSnapshot(redact(value), maxChars);
}

async function recordBrowserRun(
  supabase: any,
  identity: { lineUserId: string },
  body: Json,
): Promise<Json> {
  const suite = asText(body.suite, 20);
  if (!["quick", "full"].includes(suite)) {
    throw new ApiError(400, "INVALID_TEST_SUITE", "瀏覽器 E2E 測試類型必須是 quick 或 full。");
  }
  const runnerKind = asText(body.runnerKind, 40);
  if (!["admin-browser", "paired-browser"].includes(runnerKind)) {
    throw new ApiError(400, "INVALID_RUNNER_KIND", "不支援的瀏覽器 E2E Runner。");
  }

  const rawCases = Array.isArray(body.cases) ? body.cases : [];
  if (!rawCases.length || rawCases.length > 500) {
    throw new ApiError(400, "INVALID_BROWSER_CASES", "瀏覽器 E2E 案例數量必須介於 1–500。");
  }

  let memberId: string | null = null;
  const requestedMemberId = asText(body.memberId, 80);
  if (requestedMemberId) {
    if (!UUID_RE.test(requestedMemberId)) throw new ApiError(400, "INVALID_MEMBER_ID", "測試會員識別不正確。");
    const member = await supabase
      .from("members")
      .select("id,is_test_account,status,membership_status")
      .eq("id", requestedMemberId)
      .maybeSingle();
    if (member.error) throw new ApiError(503, "TEST_MEMBER_READ_FAILED", "目前無法確認協同測試會員。");
    if (!member.data || member.data.is_test_account !== true || member.data.status !== "active" || member.data.membership_status !== "active") {
      throw new ApiError(403, "TEST_ACCOUNT_UNAVAILABLE", "協同測試只能綁定啟用中的測試會員。");
    }
    memberId = String(member.data.id);
  }

  const normalized = rawCases.map((raw: any, index: number) => {
    const status = asText(raw?.status, 20);
    if (!["passed", "failed", "skipped"].includes(status)) {
      throw new ApiError(400, "INVALID_BROWSER_CASE_STATUS", "瀏覽器 E2E 案例狀態不正確。");
    }
    const key = asText(raw?.key, 100) || "BROWSER_CASE_" + String(index + 1);
    const name = asText(raw?.name, 180) || key;
    const domain = asText(raw?.domain, 120) || "Browser E2E";
    const message = asText(raw?.message, 1000);
    const durationMs = Math.max(0, Math.min(600000, Math.trunc(Number(raw?.durationMs) || 0)));
    const expected = safeBrowserSnapshot(raw?.expected);
    const actual = safeBrowserSnapshot(raw?.actual);
    const trace = status === "failed" ? safeBrowserTraceSnapshot(raw?.trace) : {};
    const diagnosis = status === "failed"
      ? diagnoseE2EFailure({ caseKey: key, domain, message, expected, actual, trace })
      : null;
    return {
      key, name, domain, status, message, durationMs, expected, actual, diagnosis,
      trace: diagnosis ? attachE2EDiagnosis(trace, diagnosis) : trace,
    };
  });

  const passed = normalized.filter((item) => item.status === "passed").length;
  const failed = normalized.filter((item) => item.status === "failed").length;
  const skipped = normalized.filter((item) => item.status === "skipped").length;
  const failureArtifactCases = normalized.filter((item) =>
    item.status === "failed" && Boolean((item.trace as any)?.screenshot?.path)
  ).length;
  const failureArtifactCaptureFailedCases = normalized.filter((item) =>
    item.status === "failed" && (item.trace as any)?.screenshotCapture?.status === "failed"
  ).length;
  const failureArtifactSkippedCases = normalized.filter((item) =>
    item.status === "failed" && (item.trace as any)?.screenshotCapture?.status === "skipped"
  ).length;
  const failureDiagnostics = summarizeE2EFailureDiagnoses(normalized.map((item)=>item.diagnosis).filter(Boolean));
  const featureCoverage = body.rootRun === true || runnerKind === "paired-browser" ? normalizeFeatureCoverage(body.featureCoverage) : null;
  const clientCoverage = body.rootRun === true || runnerKind === "paired-browser" ? normalizeClientFeatureCoverage(body.clientCoverage) : [];
  const scopeCoverage = runnerKind === "paired-browser" && suite === "full" ? evaluateSelectedScope({
    selectedModules: selectedE2EModules(body.selectedModules), participantCount: Number(body.participantCount),
    adminKeys: body.expectedAdminKeys, cases: normalized, featureCoverage, clientCoverage,
  }) : null;
  const featureIncomplete = (scopeCoverage && !scopeCoverage.complete) || (featureCoverage && !featureCoverage.complete) ||
    clientCoverage.some((item: any) => item.coverage && !item.coverage.complete);
  const shouldPersistReplayManifest = body.rootRun === true && runnerKind === "paired-browser" && suite === "full";
  const replayManifest = shouldPersistReplayManifest ? normalizeReplayManifest(body.replayManifest) : null;
  const replayOfRunId = asText(body.replayOfRunId,80);
  let sourceReplay:{row:any;manifest:Json}|null=null;
  if(replayOfRunId){
    if(!shouldPersistReplayManifest||!replayManifest) throw new ApiError(400,"INVALID_REPLAY_REQUEST","失敗重播只能建立完整 Root E2E 紀錄。");
    sourceReplay=await replaySourceRun(supabase,replayOfRunId);
    if(!replaySettingsMatch(sourceReplay.manifest,replayManifest)) throw new ApiError(409,"REPLAY_MANIFEST_DRIFT","本輪重播設定已偏離原始失敗流程，拒絕寫入為精準重播。");
  }
  const { startedAt, completedAt, durationMs } = browserRunWindow(body);
  const now = completedAt;
  const runInsert = await supabase.from("automation_test_runs").insert({
    run_code: runCode(),
    suite,
    environment: "MemberWebsocket-dev",
    status: failed || featureIncomplete ? "failed" : "passed",
    triggered_by: identity.lineUserId,
    total_cases: normalized.length,
    passed_cases: passed,
    failed_cases: failed,
    summary: {
      runnerVersion: asText(body.runnerVersion, 80) || "admin-browser-e2e-legacy",
      runnerKind,
      featureCoverage,
      clientCoverage,
      scopeCoverage,
      ...summarizeE2EExecution(normalized),
      ...(featureIncomplete ? { coverageComplete: false, verificationStatus: failed ? "failed" : "incomplete" } : {}),
      skippedCases: skipped,
      memberId,
      durationMs,
      rootRun: body.rootRun === true,
      rootRunId: asText(body.rootRunId, 80),
      e2eSeed: asText(body.e2eSeed, 160),
      complexityLevel: Math.max(1, Math.min(8, Number(body.complexityLevel || 1) || 1)),
      clientConcurrency: Math.max(1, Math.min(4, Number(body.clientConcurrency || 1) || 1)),
      failureDiagnosticCases: failed,
      failureArtifactCases,
      failureScreenshotCases: failureArtifactCases,
      failureArtifactCaptureFailedCases,
      failureArtifactSkippedCases,
      diagnosticsVersion: 3,
      failureDiagnostics,
      replayManifest,
      replayOfRunId: sourceReplay ? String(sourceReplay.row.id) : null,
      replayOfRunCode: sourceReplay ? String(sourceReplay.row.run_code || "") : null,
      replayComparison: sourceReplay ? replayComparison(sourceReplay.row, failureDiagnostics) : null,
    },
    started_at: startedAt,
    completed_at: completedAt,
    updated_at: now,
  }).select("id").single();
  if (runInsert.error || !runInsert.data) {
    throw new ApiError(503, "BROWSER_RUN_CREATE_FAILED", "目前無法建立瀏覽器 E2E 測試紀錄。");
  }

  const runId = String(runInsert.data.id);
  try {
    const caseRows = normalized.map((item, index) => ({
      run_id: runId,
      case_order: index + 1,
      case_key: item.key,
      name: item.name,
      domain: item.domain,
      member_id: memberId,
      status: item.status,
      failure_code: item.status === "failed" ? item.diagnosis?.code || "BROWSER_E2E_FAILED" : null,
      failure_message: item.status === "failed" ? item.message : null,
      started_at: now,
      completed_at: now,
      duration_ms: item.durationMs,
      updated_at: now,
    }));
    const inserted = await supabase.from("automation_test_cases").insert(caseRows).select("id,case_order");
    if (inserted.error || (inserted.data || []).length !== normalized.length) {
      throw new ApiError(503, "BROWSER_CASE_WRITE_FAILED", "無法完整寫入瀏覽器 E2E 案例。");
    }
    const caseIds = new Map((inserted.data || []).map((row: any) => [Number(row.case_order), String(row.id)]));
    const stepRows = normalized.flatMap((item, index) => {
      const caseId = caseIds.get(index + 1);
      if (!caseId) return [];
      const rows: any[] = [{
        case_id: caseId,
        step_order: 1,
        step_key: "browser",
        name: "瀏覽器真人操作驗證",
        status: item.status,
        expected: item.expected,
        actual: item.actual,
        message: item.message,
        started_at: now,
        completed_at: now,
        duration_ms: item.durationMs,
        updated_at: now,
      }];
      if (item.status === "failed") {
        rows.push({
          case_id: caseId,
          step_order: 2,
          step_key: "failure-trace",
          name: "失敗診斷 Artifact",
          status: "failed",
          expected: { diagnosticsCaptured: true },
          actual: item.trace,
          message: "失敗案例保留診斷分類、穩定指紋、seed、複雜度、participant、Realtime 摘要與 API timing。",
          started_at: now,
          completed_at: now,
          duration_ms: 0,
          updated_at: now,
        });
      }
      return rows;
    });
    if (stepRows.length < normalized.length) {
      throw new ApiError(503, "BROWSER_CASE_ID_MISMATCH", "瀏覽器 E2E 案例紀錄對應失敗。");
    }
    const steps = await supabase.from("automation_test_steps").insert(stepRows);
    if (steps.error) throw new ApiError(503, "BROWSER_STEP_WRITE_FAILED", "無法寫入瀏覽器 E2E 步驟。");
  } catch (error) {
    await supabase.from("automation_test_runs").delete().eq("id", runId);
    throw error;
  }

  const learningRefresh = await supabase.rpc("admin_accumulate_e2e_case_learning", { p_run_id: runId });
  if (learningRefresh.error) {
    console.error("E2E case learning refresh failed", learningRefresh.error.message);
  }

  if (body.rootRun === true && !sourceReplay) {
    const rootRunId = asText(body.rootRunId, 80);
    if (rootRunId) {
      const evolution = await supabase.rpc("admin_advance_e2e_evolution", {
        p_seed: asText(body.e2eSeed, 160),
        p_complexity_level: Math.max(1, Math.min(8, Number(body.complexityLevel || 1) || 1)),
        p_root_run_id: rootRunId,
      });
      if (evolution.error) {
        console.error("E2E evolution state update failed", evolution.error.message);
      }
    }
  }

  return runView(supabase, runId);
}

async function createRun(supabase: any, identity: { lineUserId: string }, suite: string, rawSelectedModules: unknown = null): Promise<Json> {
  if (!["quick", "full"].includes(suite)) {
    throw new ApiError(400, "INVALID_TEST_SUITE", "測試類型必須是 quick 或 full。");
  }
  const selectedModules = selectedE2EModules(rawSelectedModules);
  const defs = caseDefinitions(suite, selectedModules);
  const runInsert = await supabase
    .from("automation_test_runs")
    .insert({
      run_code: runCode(),
      suite,
      environment: "MemberWebsocket-dev",
      status: "queued",
      triggered_by: identity.lineUserId,
      total_cases: defs.length,
      passed_cases: 0,
      failed_cases: 0,
      summary: { runnerVersion: "test-control-20261001-1", selectedModules, skippedCases: 0 },
    })
    .select("id")
    .single();
  if (runInsert.error) throw new ApiError(503, "TEST_RUN_CREATE_FAILED", "目前無法建立自動化測試。");

  const runId = runInsert.data.id;
  const caseInsert = await supabase.from("automation_test_cases").insert(
    defs.map((def, index) => ({
      run_id: runId,
      case_order: index + 1,
      case_key: def.key,
      name: def.name,
      domain: def.domain,
      status: "queued",
    })),
  );
  if (caseInsert.error) {
    await supabase.from("automation_test_runs").delete().eq("id", runId);
    throw new ApiError(503, "TEST_CASE_CREATE_FAILED", "目前無法建立自動化測試案例。");
  }
  return runView(supabase, runId);
}

async function executeRun(supabase: any, runId: string): Promise<Json> {
  if (!UUID_RE.test(runId)) throw new ApiError(400, "INVALID_RUN_ID", "測試執行識別不正確。");

  const now = new Date().toISOString();
  const claim = await supabase
    .from("automation_test_runs")
    .update({ status: "running", started_at: now, updated_at: now })
    .eq("id", runId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (claim.error) throw new ApiError(503, "TEST_RUN_START_FAILED", "目前無法啟動自動化測試。");
  if (!claim.data) throw new ApiError(409, "TEST_RUN_ALREADY_STARTED", "此測試已啟動或已完成。");

  const caseResult = await supabase
    .from("automation_test_cases")
    .select("*")
    .eq("run_id", runId)
    .order("case_order", { ascending: true });
  if (caseResult.error) throw new ApiError(503, "TEST_CASE_READ_FAILED", "目前無法讀取測試案例。");

  for (const testCase of caseResult.data || []) {
    await executeCase(supabase, testCase);
    await refreshCounters(supabase, runId);
  }

  const counters = await refreshCounters(supabase, runId);
  const completedAt = new Date().toISOString();
  const finalStatus = counters.total > 0 && counters.passed === counters.total && counters.failed === 0 && counters.skipped === 0 ? "passed" : "failed";
  const finalUpdate = await supabase
    .from("automation_test_runs")
    .update({
      status: finalStatus,
      completed_at: completedAt,
      updated_at: completedAt,
      summary: {
        runnerVersion: "test-control-20261001-1",
        completedCases: counters.passed + counters.failed + counters.skipped,
        totalCases: counters.total,
        passedCases: counters.passed,
        failedCases: counters.failed,
        skippedCases: counters.skipped,
      },
    })
    .eq("id", runId);
  if (finalUpdate.error) throw new ApiError(503, "TEST_RUN_FINISH_FAILED", "目前無法完成自動化測試。");
  const learningRefresh = await supabase.rpc("admin_accumulate_e2e_case_learning", { p_run_id: runId });
  if (learningRefresh.error) {
    console.error("Backend E2E case learning refresh failed", learningRefresh.error.message);
  }
  return runView(supabase, runId);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return errorResponse(origin, new ApiError(405, "METHOD_NOT_ALLOWED", "只支援 POST。"));
  }
  if (origin && !allowedOrigins().has(origin)) {
    return errorResponse(origin, new ApiError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未被允許使用自動化測試服務。"));
  }

  try {
    const body = await readBody(request);
    if (asText(body.clientType, 20) !== "admin") {
      throw new ApiError(403, "ADMIN_SURFACE_REQUIRED", "請從管理端使用自動化測試。");
    }
    const action = asText(body.action, 80);
    if (action !== "admin.test-control.record-browser-run") {
      let requestBytes = 0;
      try { requestBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength; } catch {}
      if (requestBytes > STANDARD_REQUEST_BYTES) {
        throw new ApiError(413, "REQUEST_TOO_LARGE", "請求內容過大。");
      }
    }
    const supabase = dbClient();
    const identity = await verifyLineIdTokenContract({
      idToken: asText(body.idToken, 10_000),
      expectedChannelId: adminChannelId(),
      createError: (status, code, message, details) => new ApiError(status, code, message, details),
    });
    await requireActiveAdminContract({
      supabase,
      identity,
      createError: (status, code, message, details) => new ApiError(status, code, message, details),
    });

    if (["admin.test-control.list", "admin.test-control.status", "admin.test-control.create", "admin.test-control.purge-test-data"].includes(action)) {
      await expireAbandonedRuns(supabase);
    }

    if (action === "admin.test-control.acquire-e2e-lease") {
      return response(origin, {
        ok: true,
        status: 200,
        data: await acquireE2EExecutionLease(supabase, identity),
      });
    }

    if (action === "admin.test-control.release-e2e-lease") {
      return response(origin, {
        ok: true,
        status: 200,
        data: await releaseE2EExecutionLease(supabase, identity, body),
      });
    }

    if (action === "admin.test-control.heartbeat-e2e-lease") {
      return response(origin, {
        ok: true,
        status: 200,
        data: await heartbeatE2EExecutionLease(supabase, identity, body),
      });
    }

    if (action === "admin.test-control.recycle-e2e-runtime") {
      const leaseId = asText(body.leaseId, 80);
      if (!UUID_RE.test(leaseId)) {
        throw new ApiError(400, "INVALID_E2E_LEASE_ID", "E2E 執行鎖識別不正確。");
      }
      await expireAbandonedRuns(supabase);
      const recycled = await supabase.rpc("admin_recycle_e2e_runtime", {
        p_lease_id: leaseId,
        p_actor: identity.lineUserId,
      });
      if (recycled.error) {
        const reason = String(recycled.error.message || "");
        if (reason.includes("E2E_RECYCLE_LEASE_INVALID") || reason.includes("E2E_RECYCLE_OTHER_RUN_ACTIVE") || reason.includes("E2E_RECYCLE_BACKEND_RUN_ACTIVE")) {
          throw new ApiError(409, "E2E_RECYCLE_BUSY", "已有其他 E2E 測試正在執行，或執行鎖已失效，無法安全重置舊測試資料。");
        }
        if (reason.includes("TEST_DATA_CROSS_BOUNDARY")) {
          // Preserve the fail-closed behavior: never delete formal-member-linked data.
          throw new ApiError(409, "E2E_RECYCLE_BLOCKED",
            "測試資料與非測試會員存在關聯，已停止新一輪 E2E，請先檢查跨帳號資料。",
            { blockage: "cross_member_boundary" });
        }
        if (reason.includes("E2E_RECYCLE_QA_ARTIFACTS_REMAIN")) {
          // The SQL transaction rolls back on an incomplete purge. The number in
          // its error message is a safe aggregate, not member or ticket data.
          const remaining = /E2E_RECYCLE_QA_ARTIFACTS_REMAIN:\s*(\d+)/.exec(reason);
          throw new ApiError(409, "E2E_RECYCLE_BLOCKED",
            "上一輪 QA 資源未完全回收，已停止新一輪 E2E；請檢查測試資源的依賴關係。",
            { blockage: "qa_artifacts_remain",
              ...(remaining ? { remainingQaArtifacts: Number(remaining[1]) } : {}) });
        }
        throw new ApiError(503, "E2E_RECYCLE_FAILED", "無法安全重置上輪 E2E 測試資料，本輪測試已停止。");
      }
      const recycledSummary = recycled.data && typeof recycled.data === "object" ? recycled.data : {};
      if (recycledSummary.cleanupComplete !== true) {
        throw new ApiError(503, "E2E_RECYCLE_INCOMPLETE", "E2E 暫存資料回收未完成，已停止本輪測試。");
      }
      const deletedReceiptObjects = await purgeBookingReceiptCleanupQueue(supabase);
      const summary = { ...recycledSummary, deletedReceiptObjects };
      await audit(supabase, identity, "test_control.e2e_runtime.recycle", "test_data", leaseId, summary);
      await emitRealtimeEvent(supabase, "test_mode.e2e_runtime.recycled");
      return response(origin, { ok: true, status: 200, data: { recycle: summary } });
    }

    if (action === "admin.test-control.e2e-profile") {
      return response(origin, {
        ok: true,
        status: 200,
        data: await e2eProfile(supabase),
      });
    }

    if (action === "admin.test-control.replay-manifest") {
      const runId=asText(body.runId,80);
      const source=await replaySourceRun(supabase,runId);
      await audit(supabase,identity,"test_control.replay.prepare","automation_test_run",runId,{sourceRunCode:asText(source.row.run_code,80),complexityLevel:Number((source.manifest as any).complexityLevel||1)});
      return response(origin,{ok:true,status:200,data:{sourceRun:{id:source.row.id,runCode:source.row.run_code,status:source.row.status,failedCases:Number(source.row.failed_cases||0),createdAt:source.row.created_at},manifest:source.manifest}});
    }

    if (action === "admin.test-control.prepare-test-account-consents") {
      return response(origin, { ok: true, status: 200, data: await prepareTestAccountConsents(supabase, identity, body) });
    }

    if (action === "admin.test-control.prepare-e2e-fixtures") {
      const leaseId = asText(body.leaseId, 80);
      if (!UUID_RE.test(leaseId)) {
        throw new ApiError(409, "E2E_RECYCLE_REQUIRED", "請先取得 E2E 執行鎖並清理上一輪測試資料。");
      }
      const lease = await supabase.from("test_execution_leases")
        .select("id,runtime_recycled_at")
        .eq("id", leaseId)
        .eq("lease_type", "full_e2e")
        .eq("actor_line_user_id", identity.lineUserId)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (lease.error || !lease.data?.runtime_recycled_at) {
        throw new ApiError(409, "E2E_RECYCLE_REQUIRED", "未完成 E2E 執行前的測試資料回收，禁止新增測試資料。");
      }
      const fixture = await prepareComplexFixtures(supabase, identity, body);
      return response(origin, {
        ok: true,
        status: 201,
        data: { fixture, runs: await recentRuns(supabase) },
      }, 201);
    }

    if (action === "admin.test-control.cleanup-ticket-template") {
      const ticketTemplateId = asText(body.ticketTemplateId, 120);
      if (!ticketTemplateId) throw new ApiError(400, "INVALID_TICKET_TEMPLATE_ID", "票券識別不正確。");
      const lookup = await supabase.from("ticket_templates")
        .select("id,ticket_template_id,title,created_by")
        .eq("ticket_template_id", ticketTemplateId)
        .maybeSingle();
      if (lookup.error) throw new ApiError(503, "QA_TICKET_READ_FAILED", "目前無法確認 QA 票券。");
      if (!lookup.data) {
        return response(origin, { ok: true, status: 200, data: { deleted: true, alreadyMissing: true } });
      }
      const qaOwned = String(lookup.data.created_by || "").startsWith("qa:")
        || String(lookup.data.title || "").startsWith("E2E QA ")
        || String(lookup.data.title || "").startsWith("QA ");
      if (!qaOwned) throw new ApiError(403, "QA_TICKET_REQUIRED", "只允許清理 E2E QA 票券。");
      const refs = await Promise.all([
        supabase.from("point_card_rewards").select("id", { count: "exact", head: true }).eq("ticket_template_id", lookup.data.id),
        supabase.from("point_tickets").select("id", { count: "exact", head: true }).eq("ticket_template_id", lookup.data.id),
      ]);
      if (refs.some((item: any) => item.error)) throw new ApiError(503, "QA_TICKET_REFERENCE_CHECK_FAILED", "目前無法確認 QA 票券關聯。");
      if (refs.some((item: any) => Number(item.count || 0) > 0)) {
        return response(origin, { ok: true, status: 200, data: { deleted: false, referenced: true } });
      }
      const deleted = await supabase.from("ticket_templates").delete().eq("id", lookup.data.id);
      if (deleted.error) throw new ApiError(503, "QA_TICKET_DELETE_FAILED", "目前無法清理 QA 票券。");
      return response(origin, { ok: true, status: 200, data: { deleted: true, alreadyMissing: false } });
    }

    if (action === "admin.test-control.automation-health") {
      const health = await supabase.rpc("admin_e2e_automation_health");
      if (health.error) throw new ApiError(503,"AUTOMATION_HEALTH_UNAVAILABLE","目前無法讀取排程健康狀態。");
      return response(origin,{ok:true,status:200,data:health.data});
    }

    if (action === "admin.test-control.list") {
      return response(origin, {
        ok: true,
        status: 200,
        data: { runs: await recentRuns(supabase) },
      });
    }

    if (action === "admin.test-control.status") {
      const runId = asText(body.runId, 80);
      if (!UUID_RE.test(runId)) throw new ApiError(400, "INVALID_RUN_ID", "測試執行識別不正確。");
      let view: Json;
      try {
        view = await runView(supabase, runId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "TEST_RUN_NOT_FOUND") throw error;
        // A purge in another tab can remove a run between list and status.
        // This is an expected observation, not a missing Edge Function.
        view = { run: null, cases: [], runMissing: true };
      }
      return response(origin, {
        ok: true,
        status: 200,
        data: {
          ...view,
          runs: await recentRuns(supabase),
        },
      });
    }

    if (action === "admin.test-control.create") {
      const suite = asText(body.suite, 20);
      const created = await createRun(supabase, identity, suite, body.selectedModules);
      return response(origin, {
        ok: true,
        status: 201,
        data: {
          ...created,
          runs: await recentRuns(supabase),
        },
      }, 201);
    }

    if (action === "admin.test-control.record-browser-run") {
      const recorded = await recordBrowserRun(supabase, identity, body);
      return response(origin, {
        ok: true,
        status: 201,
        data: {
          ...recorded,
          runs: await recentRuns(supabase),
        },
      }, 201);
    }

    if (action === "admin.test-control.execute") {
      const runId = asText(body.runId, 80);
      const executed = await executeRun(supabase, runId);
      return response(origin, {
        ok: true,
        status: 200,
        data: {
          ...executed,
          runs: await recentRuns(supabase),
        },
      });
    }

    if (action === "admin.test-control.purge-test-data") {
      if (body.keepTestHistory !== undefined && typeof body.keepTestHistory !== "boolean") {
        throw new ApiError(400, "INVALID_HISTORY_RETENTION", "保留測試紀錄選項必須為布林值。");
      }
      const keepTestHistory = body.keepTestHistory !== false;
      const running = await supabase
        .from("automation_test_runs")
        .select("id", { count: "exact", head: true })
        .eq("environment", "MemberWebsocket-dev")
        .in("status", ["queued", "running"]);
      if (running.error) {
        throw new ApiError(503, "TEST_RUN_CHECK_FAILED", "目前無法確認是否仍有測試執行中。");
      }
      if (Number(running.count || 0) > 0) {
        throw new ApiError(409, "TEST_RUN_ACTIVE", "仍有測試執行中，請先停止或等待測試完成後再移除測試資料。");
      }

      const purge = await supabase.rpc("admin_purge_all_test_data_converged", { p_keep_history: keepTestHistory });
      if (purge.error) {
        const source = String(purge.error.message || purge.error.details || "");
        if (source.includes("TEST_EXECUTION_ACTIVE")) {
          throw new ApiError(409, "TEST_EXECUTION_ACTIVE", "完整 E2E 仍在執行或準備中，請停止或等待完成後再移除測試資料。");
        }
        if (source.includes("TEST_RUN_ACTIVE")) {
          throw new ApiError(409, "TEST_RUN_ACTIVE", "仍有測試執行中，請先停止或等待測試完成後再移除測試資料。");
        }
        throw new ApiError(503, "TEST_DATA_PURGE_FAILED", "目前無法移除測試資料。", purge.error.message || null);
      }
      const deletedReceiptObjects = await purgeBookingReceiptCleanupQueue(supabase);
      // Failure artifacts belong to retained E2E history, not test-member runtime data.
      const deletedStorageObjects = keepTestHistory ? 0 : await purgeE2EArtifactStorage(supabase);
      const baseSummary = purge.data && typeof purge.data === "object" ? purge.data : {};
      const summary = {
        ...(baseSummary as Json),
        historyRetained: keepTestHistory,
        deletedStorageObjects,
        deletedReceiptObjects,
      };
      await audit(
        supabase,
        identity,
        "test_control.data.purge",
        "test_data",
        "MemberWebsocket-dev",
        summary as Json,
      );
      await emitRealtimeEvent(supabase, "test_mode.data.purged");
      return response(origin, {
        ok: true,
        status: 200,
        data: {
          purge: summary,
          runs: await recentRuns(supabase),
        },
      });
    }

    throw new ApiError(404, "ACTION_NOT_FOUND", "找不到指定的自動化測試操作。");
  } catch (error) {
    return errorResponse(origin, error);
  }
});
