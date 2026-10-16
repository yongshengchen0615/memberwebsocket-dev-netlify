import { summarizeE2EExecution, normalizeFeatureCoverage } from "../_shared/e2e-coverage.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { attachE2EDiagnosis, diagnoseE2EFailure, summarizeE2EFailureDiagnoses } from "../_shared/e2e-diagnostics.js";
import { readJsonObject } from "../_shared/request-body.ts";
import { resolveTestSession, TestModeAuthError } from "../_shared/test-mode-auth.ts";

type Json = Record<string, unknown>;
type Surface = "member" | "points" | "event" | "calendar" | "booking";
type QaCase = {
  key: string;
  status: "passed" | "failed" | "skipped";
  message: string;
  expected: Json;
  actual: Json;
};

const MAX_REQUEST_BYTES = 80_000;
const STORE_SERVICE_ID = "00000000-0000-4000-8000-000000000010";
const SURFACES = new Set<Surface>(["member","points","event","calendar","booking"]);

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

function failReply(origin: string | null, error: unknown): Response {
  const e = error instanceof ApiError
    ? error
    : new ApiError(500, "USER_QA_ERROR", "用戶端自動化測試服務暫時無法完成操作。");
  return reply(origin, {
    ok: false,
    status: e.status,
    error: { code: e.code, message: e.message, details: e.details },
  }, e.status);
}

function db() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "SUPABASE_CONFIG_MISSING", "Supabase server 設定尚未完成。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function passed(key: string, message: string, expected: Json, actual: Json): QaCase {
  return { key, status: "passed", message, expected, actual };
}

function failed(key: string, message: string, expected: Json, actual: Json): QaCase {
  return { key, status: "failed", message, expected, actual };
}

function skipped(key: string, message: string, expected: Json, actual: Json): QaCase {
  return { key, status: "skipped", message, expected, actual };
}

function suffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
}

function isoDateAdd(date: string, days: number): string {
  const parsed = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime())) throw new ApiError(500, "INVALID_SERVER_DATE", "伺服器日期格式異常。");
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function callFunction(slug: string, token: string, body: Json): Promise<{ status: number; ok: boolean; data: Json; error: Json }> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(url + "/functions/v1/" + slug, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ ...body, testSessionToken: token, idToken: "" }),
  });
  const text = await response.text();
  let payload: any = {};
  try { payload = JSON.parse(text || "{}"); } catch {}
  return {
    status: response.status,
    ok: response.ok && payload?.ok === true,
    data: payload?.data && typeof payload.data === "object" ? payload.data : {},
    error: payload?.error && typeof payload.error === "object" ? payload.error : {},
  };
}

function functionError(result: { status: number; error: Json }, fallback: string): ApiError {
  return new ApiError(
    result.status || 500,
    asText(result.error.code, 120) || "DOWNSTREAM_ERROR",
    asText(result.error.message, 500) || fallback,
    result.error.details ?? null,
  );
}

async function cleanupBooking(s: any, bookingId: string): Promise<boolean> {
  if (!bookingId) return true;
  await s.from("booking_completion_settlements").delete().eq("booking_id", bookingId);
  await s.from("booking_audit_events").delete().eq("target_id", bookingId);
  const deleted = await s.from("bookings").delete().eq("id", bookingId);
  if (deleted.error) return false;
  const check = await s.from("bookings").select("id").eq("id", bookingId).maybeSingle();
  return !check.error && !check.data;
}

async function memberProfileWrite(s: any, identity: any, token: string): Promise<QaCase> {
  const key = "MEMBER_PROFILE_WRITE";
  const expected = { writeSucceeded: true, persisted: true, restored: true };
  const beforeResult = await s.from("members")
    .select("birthday,phone,surname,salutation,updated_at")
    .eq("id", identity.memberId)
    .maybeSingle();
  if (beforeResult.error || !beforeResult.data) {
    return failed(key, "無法取得測試會員原始資料。", expected, { writeSucceeded: false, persisted: false, restored: false });
  }

  const before = beforeResult.data;
  const nextBirthday = String(before.birthday || "") === "1990-01-15" ? "1991-02-16" : "1990-01-15";
  const nextPhone = String(before.phone || "") === "+886912345671" ? "+886912345672" : "+886912345671";
  const nextSurname = String(before.surname || "") === "測" ? "驗" : "測";
  const nextSalutation = String(before.salutation || "").toLowerCase() === "mr" ? "ms" : "mr";
  let writeSucceeded = false;
  let persisted = false;
  let restored = false;
  let downstreamCode = "";

  try {
    const write = await callFunction("member-profile-api", token, {
      action: "user.member.profile.save",
      clientType: "member",
      birthday: nextBirthday,
      phone: nextPhone,
      surname: nextSurname,
      salutation: nextSalutation,
    });
    writeSucceeded = write.ok;
    downstreamCode = asText(write.error.code, 120);
    if (write.ok) {
      const verify = await s.from("members").select("birthday,phone,surname,salutation").eq("id", identity.memberId).maybeSingle();
      persisted = !verify.error
        && String(verify.data?.birthday || "") === nextBirthday
        && String(verify.data?.phone || "") === nextPhone
        && String(verify.data?.surname || "") === nextSurname
        && String(verify.data?.salutation || "").toLowerCase() === nextSalutation;
    }
  } finally {
    const restore = await s.from("members").update({
      birthday: before.birthday,
      phone: before.phone,
      surname: before.surname,
      salutation: before.salutation,
      updated_at: before.updated_at,
    }).eq("id", identity.memberId);
    if (!restore.error) {
      const check = await s.from("members").select("birthday,phone,surname,salutation").eq("id", identity.memberId).maybeSingle();
      restored = !check.error
        && String(check.data?.birthday || "") === String(before.birthday || "")
        && String(check.data?.phone || "") === String(before.phone || "")
        && String(check.data?.surname || "") === String(before.surname || "")
        && String(check.data?.salutation || "").toLowerCase() === String(before.salutation || "").toLowerCase();
    }
  }

  const actual = { writeSucceeded, persisted, restored, fieldsWritten: 4, downstreamCode };
  return writeSucceeded && persisted && restored
    ? passed(key, "會員資料已透過正式 API 寫入、驗證並還原。", expected, actual)
    : failed(key, "會員資料成功寫入或還原驗證失敗。", expected, actual);
}

async function pointTicketWrite(s: any, identity: any, token: string): Promise<QaCase> {
  const key = "POINT_TICKET_WRITE";
  const expected = { singleRedeem: true, batchRedeem: true, finalBalance: 0, cleanup: true };
  const tag = suffix();
  let cardId = "";
  let ticket1 = "";
  let ticket2 = "";
  let singleRedeem = false;
  let batchRedeem = false;
  let finalBalance = -1;
  let cleanup = false;
  let errorCode = "";

  try {
    const card = await s.from("point_cards").insert({
      card_id: "QA-PC-" + tag,
      title: "QA 自動化測試卡",
      description: "Temporary automated QA card",
      status: "active",
      accent: "#5f7769",
      style_key: "forest",
      expiry_mode: "unlimited",
      sort_order: 999999,
      usage_method: "QA only",
      usage_instructions: "Temporary automated QA record",
      benefit_description: "QA only",
      created_by: "qa:" + identity.lineUserId,
      updated_by: "qa:" + identity.lineUserId,
    }).select("id").single();
    if (card.error || !card.data) throw new ApiError(500, "QA_POINT_CARD_CREATE_FAILED", "無法建立臨時 QA 集點卡。");
    cardId = String(card.data.id);

    const balance = await s.from("point_balances").insert({
      member_id: identity.memberId,
      point_card_id: cardId,
      stamps: 2,
    });
    if (balance.error) throw new ApiError(500, "QA_POINT_BALANCE_CREATE_FAILED", "無法建立臨時 QA 點數。");

    ticket1 = "QA-PT-S-" + tag;
    ticket2 = "QA-PT-B-" + tag;
    const tickets = await s.from("point_tickets").insert([
      {
        ticket_id: ticket1,
        member_id: identity.memberId,
        point_card_id: cardId,
        threshold_stamps: 1,
        ticket_type: "coupon",
        ticket_title: "QA 單筆核銷",
        ticket_description: "Temporary QA ticket",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "available",
      },
      {
        ticket_id: ticket2,
        member_id: identity.memberId,
        point_card_id: cardId,
        threshold_stamps: 1,
        ticket_type: "coupon",
        ticket_title: "QA 批次核銷",
        ticket_description: "Temporary QA ticket",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "available",
      },
    ]);
    if (tickets.error) throw new ApiError(500, "QA_POINT_TICKET_CREATE_FAILED", "無法建立臨時 QA 票券。");

    const single = await callFunction("api", token, {
      action: "user.pointcard.ticket.redeem",
      clientType: "points",
      ticketId: ticket1,
    });
    singleRedeem = single.ok;
    if (!single.ok) throw functionError(single, "單筆票券核銷失敗。");

    const batch = await callFunction("pointcard-extension-api", token, {
      operation: "member.redeem",
      ticketIds: [ticket2],
      requestId: "QA_" + tag,
    });
    batchRedeem = batch.ok;
    if (!batch.ok) throw functionError(batch, "批次票券核銷失敗。");

    const balanceCheck = await s.from("point_balances")
      .select("stamps")
      .eq("member_id", identity.memberId)
      .eq("point_card_id", cardId)
      .maybeSingle();
    if (!balanceCheck.error && balanceCheck.data) finalBalance = Number(balanceCheck.data.stamps);
  } catch (error) {
    errorCode = error instanceof ApiError ? error.code : "QA_POINT_WRITE_ERROR";
  } finally {
    if (cardId) {
      await s.from("point_tickets").delete().eq("point_card_id", cardId).eq("member_id", identity.memberId);
      await s.from("point_entries").delete().eq("point_card_id", cardId).eq("member_id", identity.memberId);
      await s.from("point_balances").delete().eq("point_card_id", cardId).eq("member_id", identity.memberId);
      await s.from("point_cards").delete().eq("id", cardId);
      const check = await s.from("point_cards").select("id").eq("id", cardId).maybeSingle();
      cleanup = !check.error && !check.data;
    }
  }

  const actual = { singleRedeem, batchRedeem, finalBalance, cleanup, errorCode };
  return singleRedeem && batchRedeem && finalBalance === 0 && cleanup
    ? passed(key, "臨時集點票券已走過單筆與批次正式核銷流程，並完整清理。", expected, actual)
    : failed(key, "集點票券成功核銷或清理驗證失敗。", expected, actual);
}

async function eventTicketWrite(s: any, identity: any, token: string): Promise<QaCase> {
  const key = "EVENT_TICKET_WRITE";
  const expected = { claimed: true, redeemed: true, lotteryResultPersisted: true, cleanup: true };
  const tag = suffix();
  let rowId = "";
  let claimId = "";
  let claimed = false;
  let redeemed = false;
  let lotteryResultPersisted = false;
  let prizeTitle = "";
  let cleanup = false;
  let errorCode = "";

  try {
    const today = new Date().toISOString().slice(0, 10);
    const inserted = await s.from("event_tickets").insert({
      event_ticket_id: "QA-EVT-LOT-" + tag,
      title: "QA 自動化活動抽獎券",
      ticket_type: "lottery",
      description: "Temporary automated QA lottery ticket",
      usage_method: "QA",
      usage_instructions: "Temporary automated QA lottery record",
      prizes: [
        { prizeTitle: "QA 抽獎 A", prizeDescription: "QA lottery prize A", winRate: 70 },
        { prizeTitle: "QA 抽獎 B", prizeDescription: "QA lottery prize B", winRate: 30 },
      ],
      status: "active",
      starts_on: isoDateAdd(today, -1),
      ends_on: isoDateAdd(today, 1),
      quota: 10,
      accent: "#5f7769",
      allowed_tier_keys: ["general","silver","gold","platinum"],
      created_by: "qa:" + identity.lineUserId,
      updated_by: "qa:" + identity.lineUserId,
    }).select("id,event_ticket_id").single();
    if (inserted.error || !inserted.data) throw new ApiError(500, "QA_EVENT_CREATE_FAILED", "無法建立臨時 QA 活動抽獎券。");
    rowId = String(inserted.data.id);

    const claim = await callFunction("api", token, {
      action: "user.event.ticket.claim",
      clientType: "event",
      eventTicketId: inserted.data.event_ticket_id,
    });
    claimed = claim.ok;
    if (!claim.ok) throw functionError(claim, "活動抽獎券領取失敗。");

    const claimRow = await s.from("event_ticket_claims")
      .select("claim_id,status,ticket_type")
      .eq("event_ticket_id", rowId)
      .eq("member_id", identity.memberId)
      .maybeSingle();
    if (claimRow.error || !claimRow.data) throw new ApiError(500, "QA_EVENT_CLAIM_MISSING", "領券後找不到活動抽獎 Claim。");
    claimId = String(claimRow.data.claim_id);
    if (claimRow.data.ticket_type !== "lottery") throw new ApiError(500, "QA_EVENT_LOTTERY_TYPE_LOST", "活動抽獎券 Claim 類型不正確。");

    const redeem = await callFunction("api", token, {
      action: "user.event.ticket.redeem",
      clientType: "event",
      claimId,
    });
    redeemed = redeem.ok;
    if (!redeem.ok) throw functionError(redeem, "活動抽獎券開獎失敗。");

    const verify = await s.from("event_ticket_claims")
      .select("status,used_at,ticket_type,result")
      .eq("claim_id", claimId)
      .maybeSingle();
    prizeTitle = asText((verify.data?.result as any)?.prizeTitle, 180);
    redeemed = redeemed && !verify.error && verify.data?.status === "used" && Boolean(verify.data?.used_at);
    lotteryResultPersisted = redeemed && verify.data?.ticket_type === "lottery" && Boolean(prizeTitle);
  } catch (error) {
    errorCode = error instanceof ApiError ? error.code : "QA_EVENT_WRITE_ERROR";
  } finally {
    if (rowId) {
      await s.from("event_ticket_claims").delete().eq("event_ticket_id", rowId).eq("member_id", identity.memberId);
      await s.from("calendar_items").delete().eq("source_event_ticket_id", rowId);
      await s.from("event_tickets").delete().eq("id", rowId);
      const check = await s.from("event_tickets").select("id").eq("id", rowId).maybeSingle();
      cleanup = !check.error && !check.data;
    }
  }

  const actual = { claimed, redeemed, lotteryResultPersisted, prizeTitle, cleanup, errorCode };
  return claimed && redeemed && lotteryResultPersisted && cleanup
    ? passed(key, "臨時活動抽獎券已完成正式領取、開獎、結果持久化並清理。", expected, actual)
    : failed(key, "活動抽獎券領取、開獎、結果保存或清理驗證失敗。", expected, actual);
}

async function calendarReadOnly(s: any, identity: any, token: string): Promise<QaCase> {
  const key = "CALENDAR_READ_ONLY";
  const expected = { testSessionCannotAdminWrite: true, calendarCountUnchanged: true };
  const before = await s.from("calendar_items").select("*", { count: "exact", head: true });
  const attempt = await callFunction("api", token, {
    action: "admin.calendar-items.save",
    clientType: "admin",
    calendarItem: {
      title: "QA SHOULD NOT WRITE",
      itemType: "event",
      startsOn: new Date().toISOString().slice(0, 10),
      status: "active",
    },
  });
  const after = await s.from("calendar_items").select("*", { count: "exact", head: true });
  const rejected = !attempt.ok && [401,403].includes(attempt.status);
  const unchanged = !before.error && !after.error && Number(before.count || 0) === Number(after.count || 0);
  const actual = {
    testSessionCannotAdminWrite: rejected,
    httpStatus: attempt.status,
    errorCode: asText(attempt.error.code, 120),
    calendarCountUnchanged: unchanged,
  };
  return rejected && unchanged
    ? passed(key, "測試會員 Session 無法越權寫入管理端日曆，資料筆數未改變。", expected, actual)
    : failed(key, "日曆寫入權限邊界或資料不變性驗證失敗。", expected, actual);
}

function bookingItems(services: any[]): { items: Json[]; normal: any | null } {
  const regular = services.filter((service: any) =>
    String(service?.serviceId || "") !== STORE_SERVICE_ID
    && service?.requiresCompanionService !== true
    && Number(service?.durationMinutes || 0) > 0
  );
  const qaRegular = regular
    .filter((service: any) => String(service?.title || "").startsWith("E2E QA 標準主服務 "))
    .sort((a: any, b: any) => Date.parse(String(b?.createdAt || "")) - Date.parse(String(a?.createdAt || "")));
  const normal = qaRegular[0] || regular[0] || null;
  const store = services.find((service: any) => String(service?.serviceId || "") === STORE_SERVICE_ID) || null;
  const items: Json[] = [];
  if (normal) items.push({ serviceId: normal.serviceId, quantity: 1 });
  if (store) items.push({ serviceId: store.serviceId, quantity: 1 });
  return { items, normal };
}

async function findBookingSlot(token: string, slug: string, action: string, itemsOrParticipants: Json, today: string, minDays: number, maxDays: number): Promise<{ date: string; startTime: string }> {
  const startOffset = Math.max(1, Number.isInteger(minDays) ? minDays : 0);
  const lastOffset = maxDays > 0 ? Math.min(maxDays, startOffset + 20) : startOffset + 14;
  for (let offset = startOffset; offset <= lastOffset; offset += 1) {
    const date = isoDateAdd(today, offset);
    const response = await callFunction(slug, token, {
      action,
      clientType: "member",
      bookingDate: date,
      ...itemsOrParticipants,
    });
    if (!response.ok) continue;
    const slots = Array.isArray((response.data as any).slots) ? (response.data as any).slots : [];
    const available = slots.find((slot: any) => slot && slot.available === true && /^\d{2}:\d{2}$/.test(String(slot.startTime || "")));
    if (available) return { date, startTime: String(available.startTime) };
  }
  throw new ApiError(409, "QA_NO_BOOKING_SLOT", "目前預約設定找不到可供 QA 使用的安全時段。");
}

async function bookingWrite(s: any, identity: any, token: string): Promise<QaCase> {
  const key = "BOOKING_WRITE";
  const expected = { created: true, updated: true, cancellationRequested: true, cleanup: true };
  let bookingId = "";
  let created = false;
  let updated = false;
  let cancellationRequested = false;
  let cleanup = false;
  let errorCode = "";

  try {
    const bootstrap = await callFunction("booking-api", token, {
      action: "user.booking.bootstrap",
      clientType: "member",
    });
    if (!bootstrap.ok) throw functionError(bootstrap, "無法讀取預約 Bootstrap。");
    const services = Array.isArray((bootstrap.data as any).services) ? (bootstrap.data as any).services : [];
    const setup = bookingItems(services);
    if (!setup.normal || !setup.items.length) {
      return skipped(key, "目前沒有可供自動化測試的主要預約項目。", expected, { created: false, updated: false, cancellationRequested: false, cleanup: true });
    }
    const settings: any = (bootstrap.data as any).settings || {};
    const today = asText((bootstrap.data as any).today, 10);
    const slot = await findBookingSlot(
      token,
      "booking-api",
      "user.booking.slots",
      { items: setup.items },
      today,
      Number(settings.minAdvanceDays || 0),
      Number(settings.maxAdvanceDays || 0),
    );

    const create = await callFunction("booking-api", token, {
      action: "user.booking.create",
      clientType: "member",
      requestId: "BOOK-QA-" + suffix(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      items: setup.items,
      memberNote: "QA automated create",
    });
    if (!create.ok) throw functionError(create, "QA 預約新增失敗。");
    const booking: any = (create.data as any).booking || {};
    bookingId = asText(booking.bookingId, 80);
    created = Boolean(bookingId && booking.status === "pending");
    if (!created) throw new ApiError(500, "QA_BOOKING_CREATE_VERIFY_FAILED", "新增後預約狀態不符合預期。");

    const update = await callFunction("booking-api", token, {
      action: "user.booking.update",
      clientType: "member",
      bookingId,
      expectedUpdatedAt: booking.updatedAt,
      requestId: "BOOK-QA-" + suffix(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      items: setup.items,
      memberNote: "QA automated update",
    });
    if (!update.ok) throw functionError(update, "QA 預約修改失敗。");
    const updatedBooking: any = (update.data as any).booking || {};
    updated = asText(updatedBooking.memberNote, 500) === "QA automated update";
    if (!updated) throw new ApiError(500, "QA_BOOKING_UPDATE_VERIFY_FAILED", "修改後預約內容未同步。");

    const cancel = await callFunction("booking-api", token, {
      action: "user.booking.cancel",
      clientType: "member",
      bookingId,
    });
    if (!cancel.ok) throw functionError(cancel, "QA 預約取消申請失敗。");
    const cancelledBooking: any = (cancel.data as any).booking || {};
    cancellationRequested = cancelledBooking.status === "cancel_requested";
  } catch (error) {
    errorCode = error instanceof ApiError ? error.code : "QA_BOOKING_WRITE_ERROR";
  } finally {
    cleanup = await cleanupBooking(s, bookingId);
  }

  const actual = { created, updated, cancellationRequested, cleanup, errorCode };
  return created && updated && cancellationRequested && cleanup
    ? passed(key, "預約已走過正式新增、修改、取消申請流程，並清除 QA 資料。", expected, actual)
    : failed(key, "預約新增、修改、取消申請或清理驗證失敗。", expected, actual);
}

async function bookingGroupWrite(s: any, identity: any, token: string): Promise<QaCase> {
  const key = "BOOKING_GROUP_WRITE";
  const expected = { created: true, updated: true, cleanup: true };
  let bookingId = "";
  let created = false;
  let updated = false;
  let cleanup = false;
  let errorCode = "";

  try {
    const [bookingBootstrap, groupBootstrap] = await Promise.all([
      callFunction("booking-api", token, { action: "user.booking.bootstrap", clientType: "member" }),
      callFunction("booking-group-api", token, { action: "user.booking.group.bootstrap", clientType: "member" }),
    ]);
    if (!bookingBootstrap.ok) throw functionError(bookingBootstrap, "無法讀取預約資料。");
    if (!groupBootstrap.ok) throw functionError(groupBootstrap, "無法讀取多人預約資源。");

    const services = Array.isArray((bookingBootstrap.data as any).services) ? (bookingBootstrap.data as any).services : [];
    const normal = bookingItems(services).normal;
    const groupSettings: any = (groupBootstrap.data as any).settings || {};
    const technicians = Array.isArray((groupBootstrap.data as any).technicians) ? (groupBootstrap.data as any).technicians : [];
    const maxPartySize = Number(groupSettings.maxPartySize || 1);
    const primaryId = asText(groupSettings.primaryTechnicianId, 80);
    if (maxPartySize < 2) {
      return skipped(key, "目前多人預約上限為 1 人，依設定略過多人成功寫入測試。", expected, { maxPartySize, cleanup: true });
    }
    if (!normal || !primaryId || !technicians.some((item: any) => item.technicianId === primaryId && item.isActive !== false)) {
      return failed(key, "多人預約已開啟，但主要技師或可測試項目設定不完整。", expected, { maxPartySize, primaryTechnicianConfigured: Boolean(primaryId), normalServiceAvailable: Boolean(normal), cleanup: true });
    }

    const participants = [
      { technicianId: primaryId, items: [{ serviceId: normal.serviceId, quantity: 1 }] },
      { technicianId: null, items: [{ serviceId: normal.serviceId, quantity: 1 }] },
    ];
    const settings: any = (bookingBootstrap.data as any).settings || {};
    const today = asText((bookingBootstrap.data as any).today, 10);
    const slot = await findBookingSlot(
      token,
      "booking-group-api",
      "user.booking.group.slots",
      { participants },
      today,
      Number(settings.minAdvanceDays || 0),
      Number(settings.maxAdvanceDays || 0),
    );

    const create = await callFunction("booking-group-api", token, {
      action: "user.booking.group.create",
      clientType: "member",
      requestId: "BOOK-QA-" + suffix(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      participants,
      memberNote: "QA automated group create",
      contactSource: "member",
    });
    if (!create.ok) throw functionError(create, "多人預約新增失敗。");
    const booking: any = (create.data as any).booking || {};
    bookingId = asText(booking.bookingId, 80);
    created = Boolean(bookingId && Number(booking.partySize || 0) >= 2);
    if (!created) throw new ApiError(500, "QA_GROUP_CREATE_VERIFY_FAILED", "多人預約新增結果不符合預期。");

    const update = await callFunction("booking-group-api", token, {
      action: "user.booking.group.update",
      clientType: "member",
      bookingId,
      expectedUpdatedAt: booking.updatedAt,
      requestId: "BOOK-QA-" + suffix(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      participants,
      memberNote: "QA automated group update",
      contactSource: "member",
    });
    if (!update.ok) throw functionError(update, "多人預約修改失敗。");
    const updatedBooking: any = (update.data as any).booking || {};
    updated = asText(updatedBooking.memberNote, 500) === "QA automated group update"
      && Number(updatedBooking.partySize || 0) >= 2;
  } catch (error) {
    errorCode = error instanceof ApiError ? error.code : "QA_GROUP_WRITE_ERROR";
  } finally {
    cleanup = await cleanupBooking(s, bookingId);
  }

  const actual = { created, updated, cleanup, errorCode };
  return created && updated && cleanup
    ? passed(key, "多人預約已走過正式新增與修改流程，並清除 QA 資料。", expected, actual)
    : failed(key, "多人預約新增、修改或清理驗證失敗。", expected, actual);
}

async function lineSuppression(s: any): Promise<QaCase> {
  const key = "LINE_SUPPRESSION";
  const expected = {
    scheduledGrantMessages: 0,
    bookingOutboxMessages: 0,
    testRecipientOutboxMessages: 0,
  };
  const snapshot = await s.rpc("automation_test_notification_snapshot");
  if (snapshot.error) {
    return failed(key, "無法讀取測試會員 LINE 通知佇列。", expected, {
      snapshotAvailable: false,
      errorCode: asText(snapshot.error.code, 120),
    });
  }
  const data: any = snapshot.data || {};
  const actual = {
    scheduledGrantMessages: Number(data.scheduledGrantMessages || 0),
    bookingOutboxMessages: Number(data.bookingOutboxMessages || 0),
    testRecipientOutboxMessages: Number(data.testRecipientOutboxMessages || 0),
  };
  const ok = actual.scheduledGrantMessages === 0
    && actual.bookingOutboxMessages === 0
    && actual.testRecipientOutboxMessages === 0;
  return ok
    ? passed(key, "測試會員沒有建立任何 LINE 發送佇列。", expected, actual)
    : failed(key, "測試會員出現 LINE 發送佇列，通知隔離邊界失敗。", expected, actual);
}

const QA_CASE_NAMES: Record<string,string> = {
  MEMBER_PROFILE_WRITE: "會員資料正式寫入／驗證／還原",
  POINT_TICKET_WRITE: "集點票券正式核銷／清理",
  EVENT_TICKET_WRITE: "活動票券正式領取／核銷／清理",
  CALENDAR_READ_ONLY: "日曆寫入權限邊界",
  BOOKING_WRITE: "預約新增／修改／取消／清理",
  BOOKING_GROUP_WRITE: "多人預約新增／修改／清理",
  LINE_SUPPRESSION: "測試會員 LINE 通知隔離",
};

async function persistUserQaRun(
  s: any,
  identity: any,
  surface: Surface,
  cases: QaCase[],
): Promise<{ runId: string; runCode: string }> {
  const now = new Date().toISOString();
  const passedCount = cases.filter((item) => item.status === "passed").length;
  const failedCount = cases.filter((item) => item.status === "failed").length;
  const skippedCount = cases.filter((item) => item.status === "skipped").length;
  const runCode = "UQA-" + Date.now().toString(36).toUpperCase() + "-" + suffix().slice(0, 8);
  const finalStatus = cases.length > 0 && passedCount === cases.length && failedCount === 0 && skippedCount === 0 ? "passed" : "failed";

  const runInsert = await s.from("automation_test_runs").insert({
    run_code: runCode,
    suite: "full",
    environment: "MemberWebsocket-dev",
    status: finalStatus,
    triggered_by: identity.lineUserId,
    total_cases: cases.length,
    passed_cases: passedCount,
    failed_cases: failedCount,
    summary: {
      runnerVersion: "user-test-api-20260921-11",
      source: "member-client",
      surface,
      ...summarizeE2EExecution(cases),
      skippedCases: skippedCount,
      memberId: identity.memberId,
      failureArtifactCases: failedCount,
    },
    started_at: now,
    completed_at: now,
    updated_at: now,
  }).select("id").single();
  if (runInsert.error || !runInsert.data) {
    throw new ApiError(503, "QA_RECORD_WRITE_FAILED", "測試已執行，但無法建立會員測試紀錄。");
  }

  const runId = String(runInsert.data.id);
  try {
    const caseInsert = await s.from("automation_test_cases").insert(
      cases.map((item, index) => {
        const actual = item.actual && typeof item.actual === "object" ? item.actual as Json : {};
        const failureCode = item.status === "failed"
          ? asText((actual as any).errorCode || (actual as any).downstreamCode, 120) || "QA_ASSERTION_FAILED"
          : null;
        return {
          run_id: runId,
          case_order: index + 1,
          case_key: item.key,
          name: QA_CASE_NAMES[item.key] || item.key,
          domain: "Member client / " + surface,
          member_id: identity.memberId,
          status: item.status,
          failure_code: failureCode,
          failure_message: item.status === "failed" ? asText(item.message, 500) : null,
          started_at: now,
          completed_at: now,
          updated_at: now,
        };
      }),
    ).select("id,case_key");
    if (caseInsert.error) throw new ApiError(503, "QA_RECORD_CASE_WRITE_FAILED", "無法寫入會員測試案例紀錄。");

    const caseIdByKey = new Map((caseInsert.data || []).map((row: any) => [String(row.case_key), String(row.id)]));
    const steps = cases.map((item) => ({
      case_id: caseIdByKey.get(item.key),
      step_order: 1,
      step_key: "verify",
      name: "正式流程驗證結果",
      status: item.status,
      expected: item.expected ?? {},
      actual: item.actual ?? {},
      message: asText(item.message, 1000),
      started_at: now,
      completed_at: now,
      duration_ms: 0,
      updated_at: now,
    })).filter((row) => Boolean(row.case_id));
    if (steps.length !== cases.length) throw new ApiError(503, "QA_RECORD_CASE_MISMATCH", "會員測試案例紀錄建立不完整。");
    const stepInsert = await s.from("automation_test_steps").insert(steps);
    if (stepInsert.error) throw new ApiError(503, "QA_RECORD_STEP_WRITE_FAILED", "無法寫入會員測試驗證資料。");
  } catch (error) {
    await s.from("automation_test_runs").delete().eq("id", runId);
    throw error;
  }

  const learningRefresh = await s.rpc("admin_accumulate_e2e_case_learning", { p_run_id: runId });
  if (learningRefresh.error) {
    console.error("User QA case learning refresh failed", learningRefresh.error.message);
  }
  return { runId, runCode };
}



function randomChoice<T>(items: T[]): T {
  if (!items.length) throw new ApiError(500, "QA_RANDOM_EMPTY", "測試狀態候選集合不可為空。");
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return items[bytes[0] % items.length];
}

async function prepareUsageState(s: any, identity: any, token: string, surface: Surface): Promise<Json> {
  const tag = suffix();
  const actor = "qa-state:" + identity.memberId + ":" + tag;
  const today = new Date().toISOString().slice(0, 10);

  if (surface === "member") {
    const pattern = randomChoice([[7, 13], [18, 42], [30, 75], [55, 125]]);
    const rows = pattern.map((minutes, index) => ({
      entry_id: "QA-STATE-SVC-" + tag + "-" + (index + 1),
      member_id: identity.memberId,
      minutes,
      note: index === 0 ? "QA STATE PACK 歷史服務" : "QA STATE PACK 近期服務",
      created_by: actor,
      created_at: new Date(Date.now() - (index === 0 ? 21 : 3) * 86400000).toISOString(),
      request_id: "QA-STATE-SVC-" + tag + "-" + (index + 1),
    }));
    const inserted = await s.from("service_time_entries").insert(rows);
    if (inserted.error) throw new ApiError(500, "QA_USAGE_MEMBER_STATE_FAILED", "無法建立會員使用狀態。", inserted.error.message);

    const termsFixture = await s.rpc("prepare_e2e_membership_terms_fixture", {
      p_member_id: identity.memberId,
      p_actor: actor,
      p_fixture_tag: tag,
    });
    if (termsFixture.error || !termsFixture.data) {
      throw new ApiError(
        500,
        "QA_USAGE_MEMBER_TERMS_FAILED",
        "無法建立會員申請條款 E2E 測試資料。",
        termsFixture.error?.message || null,
      );
    }

    return {
      usageStateTag: tag,
      prepared: true,
      scenario: "service-history-and-membership-terms",
      recordsCreated: rows.length + 1,
      stateKinds: ["historical-service", "recent-service", "membership-progress", "membership-terms-e2e"],
      serviceMinutesAdded: pattern.reduce((sum, value) => sum + value, 0),
      termsFixture: termsFixture.data,
    };
  }

  if (surface === "points") {
    const templates = await s.from("ticket_templates").insert([
      {
        ticket_template_id: "QA-STATE-TPL-C-" + tag,
        title: "QA 狀態優惠券 " + tag.slice(0, 4),
        ticket_type: "coupon",
        description: "State-pack coupon",
        usage_method: "QA",
        usage_instructions: "Test account state complexity",
        prizes: [],
        status: "active",
        created_by: actor,
        updated_by: actor,
      },
      {
        ticket_template_id: "QA-STATE-TPL-L-" + tag,
        title: "QA 狀態抽獎券 " + tag.slice(0, 4),
        ticket_type: "lottery",
        description: "State-pack lottery",
        usage_method: "QA",
        usage_instructions: "Test account state complexity",
        prizes: [
          { prizeTitle: "狀態獎 A", prizeDescription: "QA", winRate: 65 },
          { prizeTitle: "狀態獎 B", prizeDescription: "QA", winRate: 35 },
        ],
        status: "active",
        created_by: actor,
        updated_by: actor,
      },
    ]).select("id,ticket_type");
    if (templates.error || !templates.data || templates.data.length !== 2) {
      throw new ApiError(500, "QA_USAGE_POINT_TEMPLATE_FAILED", "無法建立複雜票券狀態。", templates.error?.message || null);
    }
    const coupon = templates.data.find((row: any) => row.ticket_type === "coupon");
    const lottery = templates.data.find((row: any) => row.ticket_type === "lottery");
    if (!coupon || !lottery) throw new ApiError(500, "QA_USAGE_POINT_TEMPLATE_MISSING", "複雜票券樣板建立不完整。");

    const cards = await s.from("point_cards").insert([
      {
        card_id: "QA-STATE-PC-A-" + tag,
        title: "QA 狀態集點卡 A",
        description: "Mixed available/used/expired ticket state",
        status: "active",
        accent: "#5f7769",
        style_key: "forest",
        expiry_mode: "unlimited",
        sort_order: 999910,
        usage_method: "QA",
        usage_instructions: "Test account state complexity",
        benefit_description: "多狀態票券",
        created_by: actor,
        updated_by: actor,
      },
      {
        card_id: "QA-STATE-PC-B-" + tag,
        title: "QA 狀態集點卡 B",
        description: "Date-limited low balance state",
        status: "active",
        accent: "#7b6d8d",
        style_key: "ocean",
        expiry_mode: "date",
        expires_on: isoDateAdd(today, randomChoice([9, 17, 31])),
        sort_order: 999911,
        usage_method: "QA",
        usage_instructions: "Test account state complexity",
        benefit_description: "低餘額與日期限制",
        created_by: actor,
        updated_by: actor,
      },
    ]).select("id,card_id");
    if (cards.error || !cards.data || cards.data.length !== 2) {
      throw new ApiError(500, "QA_USAGE_POINT_CARD_FAILED", "無法建立多集點卡使用狀態。", cards.error?.message || null);
    }
    const cardA = cards.data.find((row: any) => String(row.card_id).includes("-A-"));
    const cardB = cards.data.find((row: any) => String(row.card_id).includes("-B-"));
    if (!cardA || !cardB) throw new ApiError(500, "QA_USAGE_POINT_CARD_MISSING", "多集點卡狀態建立不完整。");

    const rewards = await s.from("point_card_rewards").insert([
      { reward_id: "QA-STATE-RWD-A1-" + tag, point_card_id: cardA.id, threshold_stamps: 2, ticket_template_id: coupon.id },
      { reward_id: "QA-STATE-RWD-A2-" + tag, point_card_id: cardA.id, threshold_stamps: 5, ticket_template_id: lottery.id },
      { reward_id: "QA-STATE-RWD-B1-" + tag, point_card_id: cardB.id, threshold_stamps: 3, ticket_template_id: lottery.id },
    ]).select("id,reward_id,ticket_template_id,point_card_id,threshold_stamps");
    if (rewards.error || !rewards.data || rewards.data.length !== 3) {
      throw new ApiError(500, "QA_USAGE_POINT_REWARD_FAILED", "無法建立多節點使用狀態。", rewards.error?.message || null);
    }
    const rewardA1 = rewards.data.find((row: any) => String(row.reward_id).includes("-A1-"));
    const rewardA2 = rewards.data.find((row: any) => String(row.reward_id).includes("-A2-"));
    const rewardB1 = rewards.data.find((row: any) => String(row.reward_id).includes("-B1-"));

    const cardAStamps = randomChoice([4, 6, 9]);
    const cardBStamps = randomChoice([1, 2]);
    const balances = await s.from("point_balances").insert([
      { member_id: identity.memberId, point_card_id: cardA.id, stamps: cardAStamps },
      { member_id: identity.memberId, point_card_id: cardB.id, stamps: cardBStamps },
    ]);
    if (balances.error) throw new ApiError(500, "QA_USAGE_POINT_BALANCE_FAILED", "無法建立不同點數餘額。", balances.error.message);
    const balanceEntries = await s.from("point_entries").insert([
      {
        entry_id: "QA-STATE-PTS-A-" + tag,
        member_id: identity.memberId,
        point_card_id: cardA.id,
        amount: cardAStamps,
        note: "QA STATE PACK 初始點數",
        created_by: actor,
        request_id: "QA-STATE-PTS-A-" + tag,
        entry_type: "grant",
        reference_type: "qa-state-pack",
        reference_id: tag,
      },
      {
        entry_id: "QA-STATE-PTS-B-" + tag,
        member_id: identity.memberId,
        point_card_id: cardB.id,
        amount: cardBStamps,
        note: "QA STATE PACK 初始點數",
        created_by: actor,
        request_id: "QA-STATE-PTS-B-" + tag,
        entry_type: "grant",
        reference_type: "qa-state-pack",
        reference_id: tag,
      },
    ]);
    if (balanceEntries.error) throw new ApiError(500, "QA_USAGE_POINT_ENTRY_FAILED", "無法建立與測試點數餘額一致的流水。", balanceEntries.error.message);

    const usedAt = new Date(Date.now() - 2 * 86400000).toISOString();
    const tickets = await s.from("point_tickets").insert([
      {
        ticket_id: "QA-STATE-PT-AVAILABLE-" + tag,
        member_id: identity.memberId,
        point_card_id: cardA.id,
        reward_id: rewardA1?.id || null,
        ticket_template_id: coupon.id,
        threshold_stamps: 2,
        ticket_type: "coupon",
        ticket_title: "QA 可用優惠券",
        ticket_description: "available state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "available",
      },
      {
        ticket_id: "QA-STATE-PT-USED-" + tag,
        member_id: identity.memberId,
        point_card_id: cardA.id,
        reward_id: rewardA1?.id || null,
        ticket_template_id: coupon.id,
        threshold_stamps: 2,
        ticket_type: "coupon",
        ticket_title: "QA 已使用優惠券",
        ticket_description: "used state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "used",
        used_at: usedAt,
        result: { source: "qa-state-pack", outcome: "used" },
      },
      {
        ticket_id: "QA-STATE-PT-EXPIRED-" + tag,
        member_id: identity.memberId,
        point_card_id: cardA.id,
        reward_id: rewardA2?.id || null,
        ticket_template_id: lottery.id,
        threshold_stamps: 5,
        ticket_type: "lottery",
        ticket_title: "QA 已過期抽獎券",
        ticket_description: "expired state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [
          { prizeTitle: "狀態獎 A", prizeDescription: "QA", winRate: 65 },
          { prizeTitle: "狀態獎 B", prizeDescription: "QA", winRate: 35 },
        ],
        status: "expired",
      },
      {
        ticket_id: "QA-STATE-PT-LOTTERY-" + tag,
        member_id: identity.memberId,
        point_card_id: cardB.id,
        reward_id: rewardB1?.id || null,
        ticket_template_id: lottery.id,
        threshold_stamps: 3,
        ticket_type: "lottery",
        ticket_title: "QA 可用抽獎券",
        ticket_description: "available lottery state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [
          { prizeTitle: "狀態獎 A", prizeDescription: "QA", winRate: 65 },
          { prizeTitle: "狀態獎 B", prizeDescription: "QA", winRate: 35 },
        ],
        status: "available",
      },
    ]);
    if (tickets.error) throw new ApiError(500, "QA_USAGE_POINT_TICKETS_FAILED", "無法建立可用／已用／過期票券狀態。", tickets.error.message);

    return {
      usageStateTag: tag,
      prepared: true,
      scenario: "mixed-point-ticket-lifecycle",
      recordsCreated: 11,
      stateKinds: ["multi-card", "high-balance", "low-balance", "available-ticket", "used-ticket", "expired-ticket", "lottery-ticket", "date-limited-card"],
      cardIds: [cardA.card_id, cardB.card_id],
    };
  }

  if (surface === "event") {
    const eventRows = [
      {
        event_ticket_id: "QA-STATE-EVT-OPEN-" + tag,
        title: "QA 可領活動票券",
        ticket_type: "coupon",
        description: "claimable state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "active",
        starts_on: isoDateAdd(today, -2),
        ends_on: isoDateAdd(today, 8),
        quota: 8,
        accent: "#5f7769",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
      {
        event_ticket_id: "QA-STATE-EVT-CLAIMED-" + tag,
        title: "QA 已領待使用活動票券",
        ticket_type: "coupon",
        description: "claimed state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "active",
        starts_on: isoDateAdd(today, -3),
        ends_on: isoDateAdd(today, 6),
        quota: 9,
        accent: "#4f7189",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
      {
        event_ticket_id: "QA-STATE-EVT-USED-" + tag,
        title: "QA 已使用活動票券",
        ticket_type: "coupon",
        description: "used state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "active",
        starts_on: isoDateAdd(today, -12),
        ends_on: isoDateAdd(today, 3),
        quota: 0,
        accent: "#7d6a91",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
      {
        event_ticket_id: "QA-STATE-EVT-FUTURE-" + tag,
        title: "QA 尚未開始活動票券",
        ticket_type: "lottery",
        description: "future state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [
          { prizeTitle: "未來獎", prizeDescription: "QA", winRate: 100 },
        ],
        status: "active",
        starts_on: isoDateAdd(today, 5),
        ends_on: isoDateAdd(today, 20),
        quota: 3,
        accent: "#9b7a49",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
      {
        event_ticket_id: "QA-STATE-EVT-PAST-" + tag,
        title: "QA 已結束活動票券",
        ticket_type: "coupon",
        description: "past state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "active",
        starts_on: isoDateAdd(today, -20),
        ends_on: isoDateAdd(today, -1),
        quota: 2,
        accent: "#666666",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
    ];
    const inserted = await s.from("event_tickets").insert(eventRows).select("id,event_ticket_id,ticket_type,title");
    if (inserted.error || !inserted.data || inserted.data.length !== eventRows.length) {
      throw new ApiError(500, "QA_USAGE_EVENT_FAILED", "無法建立活動票券多生命週期狀態。", inserted.error?.message || null);
    }
    const claimed = inserted.data.find((row: any) => String(row.event_ticket_id).includes("-CLAIMED-"));
    const used = inserted.data.find((row: any) => String(row.event_ticket_id).includes("-USED-"));
    if (!claimed || !used) throw new ApiError(500, "QA_USAGE_EVENT_STATE_MISSING", "活動票券狀態建立不完整。");
    const claims = await s.from("event_ticket_claims").insert([
      {
        claim_id: "QA-STATE-CLAIM-OPEN-" + tag,
        event_ticket_id: claimed.id,
        member_id: identity.memberId,
        ticket_type: claimed.ticket_type,
        ticket_title: claimed.title,
        ticket_description: "claimed state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "claimed",
      },
      {
        claim_id: "QA-STATE-CLAIM-USED-" + tag,
        event_ticket_id: used.id,
        member_id: identity.memberId,
        ticket_type: used.ticket_type,
        ticket_title: used.title,
        ticket_description: "used state",
        usage_method: "QA",
        usage_instructions: "QA",
        prizes: [],
        status: "used",
        used_at: new Date(Date.now() - 86400000).toISOString(),
        result: { source: "qa-state-pack", outcome: "used" },
      },
    ]);
    if (claims.error) throw new ApiError(500, "QA_USAGE_EVENT_CLAIMS_FAILED", "無法建立已領／已使用活動票券狀態。", claims.error.message);
    return {
      usageStateTag: tag,
      prepared: true,
      scenario: "mixed-event-ticket-lifecycle",
      recordsCreated: 7,
      stateKinds: ["claimable", "claimed", "used", "future", "past", "limited-quota", "lottery"],
    };
  }

  if (surface === "calendar") {
    const items = [
      {
        calendar_item_id: "QA-STATE-CAL-TODAY-" + tag,
        title: "QA 今日活動",
        item_type: "event",
        description: "today event",
        starts_on: today,
        ends_on: today,
        status: "active",
        accent: "#5f7769",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        link_label: "",
        link_url: "",
        created_by: actor,
        updated_by: actor,
        audience_type: "all",
      },
      {
        calendar_item_id: "QA-STATE-CAL-HOL-" + tag,
        title: "QA 測試公休日",
        item_type: "holiday",
        description: "holiday state",
        starts_on: isoDateAdd(today, 1),
        ends_on: isoDateAdd(today, 1),
        status: "active",
        accent: "#b15d5d",
        allowed_tier_keys: [],
        link_label: "",
        link_url: "",
        created_by: actor,
        updated_by: actor,
        audience_type: "all",
      },
      {
        calendar_item_id: "QA-STATE-CAL-MULTI-" + tag,
        title: "QA 多日活動",
        item_type: "event",
        description: "multi-day state",
        starts_on: isoDateAdd(today, 2),
        ends_on: isoDateAdd(today, 5),
        status: "active",
        accent: "#6d6793",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        link_label: "QA 詳情",
        link_url: "https://example.com/qa-state",
        created_by: actor,
        updated_by: actor,
        audience_type: "all",
      },
      {
        calendar_item_id: "QA-STATE-CAL-FUTURE-" + tag,
        title: "QA 未來活動",
        item_type: "event",
        description: "future state",
        starts_on: isoDateAdd(today, 14),
        ends_on: isoDateAdd(today, 14),
        status: "active",
        accent: "#9a7848",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        link_label: "",
        link_url: "",
        created_by: actor,
        updated_by: actor,
        audience_type: "all",
      },
      {
        calendar_item_id: "QA-STATE-CAL-ARCHIVED-" + tag,
        title: "QA 歷史封存活動",
        item_type: "event",
        description: "archived state",
        starts_on: isoDateAdd(today, -18),
        ends_on: isoDateAdd(today, -17),
        status: "archived",
        accent: "#777777",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        link_label: "",
        link_url: "",
        created_by: actor,
        updated_by: actor,
        audience_type: "all",
      },
    ];
    const inserted = await s.from("calendar_items").insert(items);
    if (inserted.error) throw new ApiError(500, "QA_USAGE_CALENDAR_FAILED", "無法建立日曆多狀態資料。", inserted.error.message);
    return {
      usageStateTag: tag,
      prepared: true,
      scenario: "mixed-calendar-state",
      recordsCreated: items.length,
      stateKinds: ["today", "holiday", "multi-day", "future", "archived"],
      focusDate: today,
    };
  }

  const bootstrap = await callFunction("booking-api", token, {
    action: "user.booking.bootstrap",
    clientType: "member",
  });
  if (!bootstrap.ok) throw functionError(bootstrap, "無法建立預約使用狀態：Bootstrap 失敗。");
  const services = Array.isArray((bootstrap.data as any).services) ? (bootstrap.data as any).services : [];
  const setup = bookingItems(services);
  if (!setup.normal || !setup.items.length) {
    return {
      usageStateTag: tag,
      prepared: true,
      scenario: "booking-no-resource",
      recordsCreated: 0,
      stateKinds: ["no-bookable-resource"],
      skipped: true,
    };
  }
  const settings: any = (bootstrap.data as any).settings || {};
  const bootstrapToday = asText((bootstrap.data as any).today, 10);
  const createdStates: Json[] = [];
  const stateFailures: Json[] = [];
  for (const targetState of ["pending", "cancel_requested"]) {
    let stateCreated = false;
    for (let attempt = 0; attempt < 8 && !stateCreated; attempt += 1) {
      let bookingId = "";
      try {
        const slot = await findBookingSlot(
          token,
          "booking-api",
          "user.booking.slots",
          { items: setup.items },
          bootstrapToday,
          Number(settings.minAdvanceDays || 0),
          Number(settings.maxAdvanceDays || 0),
        );
        const create = await callFunction("booking-api", token, {
          action: "user.booking.create",
          clientType: "member",
          requestId: "BOOK-STATE-" + suffix(),
          bookingDate: slot.date,
          startTime: slot.startTime,
          items: setup.items,
          memberNote: "QA STATE PACK " + targetState + " " + tag,
        });
        if (!create.ok) {
          stateFailures.push({
            state: targetState,
            attempt: attempt + 1,
            stage: "create",
            code: asText(create.error.code, 120),
          });
        } else {
          const booking: any = (create.data as any).booking || {};
          bookingId = asText(booking.bookingId, 80);
          if (!bookingId) {
            stateFailures.push({ state: targetState, attempt: attempt + 1, stage: "identity" });
          } else if (targetState === "cancel_requested") {
            const cancelled = await callFunction("booking-api", token, {
              action: "user.booking.cancel",
              clientType: "member",
              bookingId,
            });
            if (cancelled.ok) {
              createdStates.push({ bookingId, state: "cancel_requested" });
              stateCreated = true;
            } else {
              stateFailures.push({
                state: targetState,
                attempt: attempt + 1,
                stage: "cancel",
                code: asText(cancelled.error.code, 120),
              });
              await cleanupBooking(s, bookingId);
              bookingId = "";
            }
          } else {
            createdStates.push({ bookingId, state: "pending" });
            stateCreated = true;
          }
        }
      } catch (error) {
        if (bookingId) await cleanupBooking(s, bookingId);
        stateFailures.push({
          state: targetState,
          attempt: attempt + 1,
          stage: "slot-or-create",
          code: error instanceof ApiError ? error.code : "QA_STATE_PACK_RETRY",
        });
      }
      if (!stateCreated && attempt < 7) {
        await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 80));
      }
    }
  }
  return {
    usageStateTag: tag,
    prepared: true,
    scenario: "mixed-booking-lifecycle",
    recordsCreated: createdStates.length,
    stateKinds: createdStates.map((row: any) => asText(row.state, 40)),
    bookings: createdStates,
    failures: stateFailures.slice(-8),
    skipped: createdStates.length === 0,
  };
}

function requireFixtureTag(value: unknown): string {
  const tag = asText(value, 32).toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(tag)) throw new ApiError(400, "INVALID_QA_FIXTURE", "測試 Fixture 識別碼不正確。");
  return tag;
}

async function preparePointRedemptionBooking(s: any, identity: any, tag: string, ticketId: string): Promise<string> {
  if (identity.isTestAccount !== true || identity.surface !== "points") {
    throw new ApiError(403, "TEST_ACCOUNT_REQUIRED", "票券預約前置資料只允許集點卡測試 Session 建立。");
  }
  const actor = "qa-ui:" + identity.memberId + ":" + requireFixtureTag(tag);
  const [settingsResult, servicesResult, storeResult, holidaysResult] = await Promise.all([
    s.from("booking_settings").select("*").eq("id", 1).single(),
    s.from("booking_services").select("id,title,duration_minutes")
      .eq("is_active", true).eq("requires_companion_service", false)
      .like("created_by", "qa:%").order("created_at", { ascending: false }).limit(1),
    s.from("booking_services").select("id,duration_minutes").eq("id", STORE_SERVICE_ID).eq("is_active", true).single(),
    s.from("calendar_items").select("starts_on,ends_on").eq("item_type", "holiday").eq("status", "active"),
  ]);
  const settings = settingsResult.data;
  const service = servicesResult.data?.[0];
  const store = storeResult.data;
  if (settingsResult.error || servicesResult.error || storeResult.error || holidaysResult.error || !settings || !service || !store) {
    throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "請先建立 E2E 預約測試資源，再測試票券核銷。");
  }
  const minutes = (time: unknown) => {
    const [hour, minute] = String(time || "").split(":").map(Number);
    return hour * 60 + minute;
  };
  const start = minutes(settings.work_start_time);
  let end = minutes(settings.work_end_time);
  if (end <= start) end += 1440;
  const interval = Math.max(1, Number(settings.slot_interval_minutes || 15));
  const duration = Number(service.duration_minutes) + Number(store.duration_minutes);
  const slotCount = Math.floor((end - start - duration) / interval) + 1;
  if (!Number.isFinite(slotCount) || slotCount < 1) {
    throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "測試服務無法放入目前營業時段。");
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const firstDay = Math.max(1, Number(settings.min_advance_days || 0));
  const lastDay = Number(settings.max_advance_days) > 0 ? Number(settings.max_advance_days) : firstDay + 7;
  const dayCount = lastDay - firstDay + 1;
  if (dayCount < 1) throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "目前預約日期範圍不足以建立測試預約。");
  const seed = Number.parseInt(tag.slice(0, 8), 16);
  const requestId = "BOOK-QA-POINTS-" + tag;
  const holidays = holidaysResult.data || [];
  let bookingId = "";
  // Spread probes across dates and distinct time slots. A five-slot retry
  // makes human E2E flaky whenever the calendar has a handful of collisions.
  // Cap backend RPC attempts so a fully booked calendar cannot stall the runner.
  const candidateLimit = Math.min(dayCount * slotCount, 96);
  for (let attempt = 0; attempt < candidateLimit; attempt += 1) {
    const dayIndex = attempt % dayCount;
    const timeRound = Math.floor(attempt / dayCount);
    const slotIndex = (seed + dayIndex * 7 + timeRound) % slotCount;
    const date = isoDateAdd(today, firstDay + ((seed + dayIndex) % dayCount));
    if (holidays.some((row: any) => row.starts_on <= date && (row.ends_on || row.starts_on) >= date)) continue;
    const cursor = (start + slotIndex * interval) % 1440;
    const time = String(Math.floor(cursor / 60)).padStart(2, "0") + ":" + String(cursor % 60).padStart(2, "0");
    const created = await s.rpc("create_booking_bundle_request", {
      p_request_id: requestId, p_member_id: identity.memberId, p_booking_date: date,
      p_start_time: time, p_items: [{ serviceId: service.id, quantity: 1 }, { serviceId: store.id, quantity: 1 }],
      p_member_note: "QA HUMAN E2E POINTS " + tag,
    });
    if (created.error) {
      if (/BOOKING_SLOT_TAKEN/.test(String(created.error.message || ""))) continue;
      throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "無法建立票券核銷需要的 QA 預約。");
    }
    if (created.data?.status !== "pending") {
      throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "測試預約已進入後續狀態，請建立新的測試資料。");
    }
    bookingId = asText(created.data?.id, 80);
    if (bookingId) break;
  }
  if (!bookingId) throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "目前找不到票券核銷前置資料的安全時段。");
  try {
    // This is fixture setup, not a member-facing confirmation capability. The
    // authenticated test member, request and QA service are all server-derived.
    const confirmed = await s.from("bookings").update({ status: "confirmed", confirmed_by: actor, confirmed_at: new Date().toISOString() })
      .eq("id", bookingId).eq("member_id", identity.memberId).eq("request_id", requestId).eq("status", "pending")
      .select("id,status").single();
    if (confirmed.error || confirmed.data?.status !== "confirmed") throw new Error("confirmation failed");
    const eligible = await s.rpc("member_ticket_booking_options", { p_member_id: identity.memberId });
    if (eligible.error || !eligible.data?.points?.[ticketId]?.some((row: any) => row.bookingId === bookingId)) {
      throw new Error("eligibility failed");
    }
    const audit = await s.from("booking_audit_events").insert({
      actor_line_user_id: actor, actor_role: "system", action: "QA_POINT_REDEMPTION_FIXTURE",
      target_type: "booking", target_id: bookingId, result: "success", metadata: { fixtureTag: tag },
    });
    if (audit.error) throw new Error("audit failed");
    return bookingId;
  } catch {
    await cleanupBooking(s, bookingId);
    throw new ApiError(409, "QA_FIXTURE_BOOKING_NOT_READY", "QA 預約確認或核銷資格回讀失敗。");
  }
}

async function prepareHumanFixture(s: any, identity: any, surface: Surface): Promise<Json> {
  const tag = suffix();
  const actor = "qa-ui:" + identity.memberId + ":" + tag;
  const today = new Date().toISOString().slice(0, 10);

  if (surface === "points") {
    const template = await s.from("ticket_templates").insert({
      ticket_template_id: "QA-UI-TPL-" + tag,
      title: "QA 真人操作票券",
      ticket_type: "coupon",
      description: "Human-like E2E fixture",
      usage_method: "QA UI",
      usage_instructions: "Only for test account human-like E2E",
      prizes: [],
      status: "active",
      created_by: actor,
      updated_by: actor,
    }).select("id").single();
    if (template.error || !template.data) throw new ApiError(500, "QA_FIXTURE_TEMPLATE_FAILED", "無法建立集點票券測試樣板。");

    const card = await s.from("point_cards").insert({
      card_id: "QA-UI-PC-" + tag,
      title: "QA 真人操作集點卡",
      description: "Human-like E2E fixture",
      status: "active",
      accent: "#5f7769",
      style_key: "forest",
      expiry_mode: "unlimited",
      sort_order: 999999,
      usage_method: "QA UI",
      usage_instructions: "Only for test account human-like E2E",
      benefit_description: "QA fixture",
      created_by: actor,
      updated_by: actor,
    }).select("id,card_id").single();
    if (card.error || !card.data) {
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_CARD_FAILED", "無法建立集點卡測試資料。");
    }

    const reward = await s.from("point_card_rewards").insert({
      reward_id: "QA-UI-RWD-" + tag,
      point_card_id: card.data.id,
      threshold_stamps: 1,
      ticket_template_id: template.data.id,
    }).select("id").single();
    if (reward.error || !reward.data) {
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_REWARD_FAILED", "無法建立集點獎勵測試資料。");
    }

    const balance = await s.from("point_balances").insert({
      member_id: identity.memberId,
      point_card_id: card.data.id,
      stamps: 2,
    });
    if (balance.error) {
      await s.from("point_card_rewards").delete().eq("id", reward.data.id);
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_BALANCE_FAILED", "無法建立測試會員點數。");
    }
    const balanceEntry = await s.from("point_entries").insert({
      entry_id: "QA-UI-PTS-" + tag,
      member_id: identity.memberId,
      point_card_id: card.data.id,
      amount: 2,
      note: "QA 真人操作初始點數",
      created_by: actor,
      request_id: "QA-UI-PTS-" + tag,
      entry_type: "grant",
      reference_type: "qa-ui-fixture",
      reference_id: tag,
    });
    if (balanceEntry.error) {
      await s.from("point_balances").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
      await s.from("point_card_rewards").delete().eq("id", reward.data.id);
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_POINT_ENTRY_FAILED", "無法建立與測試點數餘額一致的流水。");
    }

    // Use the same eligibility issuance path as the real client instead of racing
    // the client's automatic issuance with a second direct INSERT.
    const issuance = await s.rpc("issue_eligible_point_tickets", {
      p_member_id: identity.memberId,
      p_point_card_id: card.data.id,
    });

    let ticket: any = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const lookup = await s.from("point_tickets")
        .select("ticket_id")
        .eq("member_id", identity.memberId)
        .eq("point_card_id", card.data.id)
        .eq("reward_id", reward.data.id)
        .eq("status", "available")
        .maybeSingle();
      if (!lookup.error && lookup.data) {
        ticket = lookup.data;
        break;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 60));
    }

    if (!ticket) {
      // An issuance failure also requires ledger cleanup; removing only the
      // balance/reward leaves a point_entries FK and prevents deleting the card.
      try {
        await cleanupHumanFixture(s, identity, "points", { fixtureTag: tag });
        const remaining = await s.from("point_cards").select("id").eq("card_id", card.data.card_id).maybeSingle();
        if (remaining.error || remaining.data) throw new Error("QA point fixture still exists");
      } catch {
        throw new ApiError(500, "QA_FIXTURE_CLEANUP_FAILED", "票券發放失敗，且無法完整清理已建立的 QA 資料。");
      }
      throw new ApiError(
        500,
        "QA_FIXTURE_POINT_TICKET_FAILED",
        "無法建立可操作的測試票券。",
        { issueCode: asText(issuance.error?.code, 40) || null },
      );
    }

    try {
      const bookingId = await preparePointRedemptionBooking(s, identity, tag, ticket.ticket_id);
      return { fixtureTag: tag, cardId: card.data.card_id, ticketId: ticket.ticket_id, bookingId, expectedStamps: 2 };
    } catch (error) {
      // Preparation has not returned fixtureTag to the browser yet, so the
      // client cannot invoke normal cleanup. Remove the partial point fixture
      // server-side before propagating the original booking error.
      try {
        await cleanupHumanFixture(s, identity, "points", { fixtureTag: tag });
        const remaining = await s.from("point_cards").select("id").eq("card_id", "QA-UI-PC-" + tag).maybeSingle();
        if (remaining.error || remaining.data) throw new Error("QA point fixture still exists");
      } catch {
        throw new ApiError(500, "QA_FIXTURE_CLEANUP_FAILED", "票券預約準備失敗，且無法完整清理已建立的 QA 資料。");
      }
      throw error;
    }
  }

  if (surface === "event") {
    const events = await s.from("event_tickets").insert([
      {
        event_ticket_id: "QA-UI-EVT-" + tag,
        title: "QA 真人操作活動優惠券",
        ticket_type: "coupon",
        description: "Human-like E2E coupon fixture",
        usage_method: "QA UI",
        usage_instructions: "Only for test account human-like E2E",
        prizes: [],
        status: "active",
        starts_on: isoDateAdd(today, -1),
        ends_on: isoDateAdd(today, 1),
        quota: 10,
        accent: "#5f7769",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
      {
        event_ticket_id: "QA-UI-EVT-LOT-" + tag,
        title: "QA 真人操作活動抽獎券",
        ticket_type: "lottery",
        description: "Human-like E2E lottery fixture",
        usage_method: "QA UI 開獎",
        usage_instructions: "Only for test account human-like E2E",
        prizes: [
          { prizeTitle: "QA 頭獎", prizeDescription: "活動抽獎券 E2E 頭獎", winRate: 60 },
          { prizeTitle: "QA 二獎", prizeDescription: "活動抽獎券 E2E 二獎", winRate: 30 },
          { prizeTitle: "QA 參加獎", prizeDescription: "活動抽獎券 E2E 參加獎", winRate: 10 },
        ],
        status: "active",
        starts_on: isoDateAdd(today, -1),
        ends_on: isoDateAdd(today, 1),
        quota: 10,
        accent: "#7d6a91",
        allowed_tier_keys: ["general","silver","gold","platinum"],
        created_by: actor,
        updated_by: actor,
      },
    ]).select("id,event_ticket_id,ticket_type");
    if (events.error || !events.data || events.data.length !== 2) {
      throw new ApiError(500, "QA_FIXTURE_EVENT_FAILED", "無法建立活動優惠券與活動抽獎券測試資料。", events.error?.message || null);
    }
    const coupon = events.data.find((row: any) => row.ticket_type === "coupon");
    const lottery = events.data.find((row: any) => row.ticket_type === "lottery");
    if (!coupon || !lottery) throw new ApiError(500, "QA_FIXTURE_EVENT_TYPE_MISSING", "活動票券測試資料類型建立不完整。");
    return {
      fixtureTag: tag,
      eventTicketId: coupon.event_ticket_id,
      lotteryEventTicketId: lottery.event_ticket_id,
      lotteryPrizeCount: 3,
    };
  }

  if (surface === "booking") {
    const template = await s.from("ticket_templates").insert({
      ticket_template_id: "QA-UI-BOOK-TPL-" + tag,
      title: "QA 預約自動核銷票券",
      ticket_type: "coupon",
      description: "Booking benefit human-like E2E fixture",
      usage_method: "QA booking",
      usage_instructions: "Only for test account booking benefit E2E",
      prizes: [],
      status: "active",
      created_by: actor,
      updated_by: actor,
    }).select("id").single();
    if (template.error || !template.data) throw new ApiError(500, "QA_FIXTURE_BOOKING_TEMPLATE_FAILED", "無法建立預約優惠測試樣板。");

    const card = await s.from("point_cards").insert({
      card_id: "QA-UI-BOOK-PC-" + tag,
      title: "QA 預約核銷集點卡",
      description: "Booking benefit human-like E2E fixture",
      status: "active",
      accent: "#5f7769",
      style_key: "forest",
      expiry_mode: "unlimited",
      sort_order: 999998,
      usage_method: "QA booking",
      usage_instructions: "Only for test account booking benefit E2E",
      benefit_description: "QA booking benefit fixture",
      created_by: actor,
      updated_by: actor,
    }).select("id,card_id").single();
    if (card.error || !card.data) {
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_BOOKING_CARD_FAILED", "無法建立預約優惠測試集點卡。");
    }

    const reward = await s.from("point_card_rewards").insert({
      reward_id: "QA-UI-BOOK-RWD-" + tag,
      point_card_id: card.data.id,
      threshold_stamps: 1,
      ticket_template_id: template.data.id,
    }).select("id").single();
    if (reward.error || !reward.data) {
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_BOOKING_REWARD_FAILED", "無法建立預約優惠測試獎勵。");
    }

    const balance = await s.from("point_balances").insert({
      member_id: identity.memberId,
      point_card_id: card.data.id,
      stamps: 2,
    });
    if (balance.error) {
      await s.from("point_card_rewards").delete().eq("id", reward.data.id);
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_BOOKING_BALANCE_FAILED", "無法建立預約優惠測試點數。");
    }
    const balanceEntry = await s.from("point_entries").insert({
      entry_id: "QA-UI-BOOK-PTS-" + tag,
      member_id: identity.memberId,
      point_card_id: card.data.id,
      amount: 2,
      note: "QA 預約優惠初始點數",
      created_by: actor,
      request_id: "QA-UI-BOOK-PTS-" + tag,
      entry_type: "grant",
      reference_type: "qa-ui-booking-benefit",
      reference_id: tag,
    });
    if (balanceEntry.error) {
      await s.from("point_balances").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
      await s.from("point_card_rewards").delete().eq("id", reward.data.id);
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(500, "QA_FIXTURE_BOOKING_POINT_ENTRY_FAILED", "無法建立預約優惠點數流水。");
    }

    const issuance = await s.rpc("issue_eligible_point_tickets", {
      p_member_id: identity.memberId,
      p_point_card_id: card.data.id,
    });
    let ticket: any = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const lookup = await s.from("point_tickets")
        .select("ticket_id,status")
        .eq("member_id", identity.memberId)
        .eq("point_card_id", card.data.id)
        .eq("reward_id", reward.data.id)
        .eq("status", "available")
        .maybeSingle();
      if (!lookup.error && lookup.data) {
        ticket = lookup.data;
        break;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 60));
    }
    if (!ticket) {
      await s.from("point_tickets").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
      await s.from("point_entries").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
      await s.from("point_balances").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
      await s.from("point_card_rewards").delete().eq("id", reward.data.id);
      await s.from("point_cards").delete().eq("id", card.data.id);
      await s.from("ticket_templates").delete().eq("id", template.data.id);
      throw new ApiError(
        500,
        "QA_FIXTURE_BOOKING_TICKET_FAILED",
        "無法建立預約可勾選的測試票券。",
        { issueCode: asText(issuance.error?.code, 40) || null },
      );
    }

    return {
      fixtureTag: tag,
      cardId: card.data.card_id,
      ticketId: ticket.ticket_id,
      ticketTitle: "QA 預約自動核銷票券",
      expectedStamps: 2,
    };
  }

  if (surface === "calendar") {
    const item = await s.from("calendar_items").insert({
      calendar_item_id: "QA-UI-CAL-" + tag,
      title: "QA 真人操作日曆項目",
      item_type: "event",
      description: "Human-like E2E fixture",
      starts_on: today,
      ends_on: today,
      status: "active",
      accent: "#5f7769",
      allowed_tier_keys: ["general","silver","gold","platinum"],
      link_label: "",
      link_url: "",
      created_by: actor,
      updated_by: actor,
      audience_type: "all",
    }).select("id,calendar_item_id,starts_on").single();
    if (item.error || !item.data) throw new ApiError(500, "QA_FIXTURE_CALENDAR_FAILED", "無法建立日曆測試資料。");
    return { fixtureTag: tag, calendarItemId: item.data.calendar_item_id, date: item.data.starts_on };
  }

  return { fixtureTag: tag };
}

async function cleanupHumanFixture(s: any, identity: any, surface: Surface, body: Json): Promise<Json> {
  if (surface === "booking") {
    const bookingId = asText(body.bookingId, 80);
    if (bookingId) {
      const booking = await s.from("bookings").select("id,member_id,member_note").eq("id", bookingId).maybeSingle();
      if (booking.error) throw new ApiError(500, "QA_FIXTURE_LOOKUP_FAILED", "無法確認預約測試資料。");
      if (booking.data) {
        if (String(booking.data.member_id) !== identity.memberId || !String(booking.data.member_note || "").startsWith("QA HUMAN E2E")) {
          throw new ApiError(403, "QA_FIXTURE_OWNERSHIP_FAILED", "只允許清理由目前測試會員建立的 QA 預約。");
        }
        const cleaned = await cleanupBooking(s, bookingId);
        if (!cleaned) throw new ApiError(500, "QA_FIXTURE_CLEANUP_FAILED", "預約測試資料清理失敗。");
      }
    }

    const rawTag = asText(body.fixtureTag, 32);
    if (rawTag) {
      const tag = requireFixtureTag(rawTag);
      const actorPrefix = "qa-ui:" + identity.memberId + ":" + tag;
      const card = await s.from("point_cards").select("id,created_by").eq("card_id", "QA-UI-BOOK-PC-" + tag).maybeSingle();
      if (card.error) throw new ApiError(500, "QA_FIXTURE_LOOKUP_FAILED", "無法確認預約優惠測試資料。");
      if (card.data) {
        if (String(card.data.created_by) !== actorPrefix) throw new ApiError(403, "QA_FIXTURE_OWNERSHIP_FAILED", "預約優惠測試資料不屬於目前測試會員。");
        await s.from("point_tickets").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
        await s.from("point_entries").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
        await s.from("point_balances").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
        const rewards = await s.from("point_card_rewards").select("ticket_template_id").eq("point_card_id", card.data.id);
        await s.from("point_card_rewards").delete().eq("point_card_id", card.data.id);
        await s.from("point_cards").delete().eq("id", card.data.id);
        for (const row of rewards.data || []) {
          if (row.ticket_template_id) await s.from("ticket_templates").delete().eq("id", row.ticket_template_id).eq("created_by", actorPrefix);
        }
      }
    }
    return { cleaned: true };
  }

  const tag = requireFixtureTag(body.fixtureTag);
  const actorPrefix = "qa-ui:" + identity.memberId + ":" + tag;

  if (surface === "points") {
    const card = await s.from("point_cards").select("id,created_by").eq("card_id", "QA-UI-PC-" + tag).maybeSingle();
    if (card.error) throw new ApiError(500, "QA_FIXTURE_LOOKUP_FAILED", "無法確認集點卡測試資料。");
    if (!card.data) return { cleaned: true };
    if (String(card.data.created_by) !== actorPrefix) throw new ApiError(403, "QA_FIXTURE_OWNERSHIP_FAILED", "測試資料不屬於目前測試會員。");
    await s.from("point_tickets").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
    await s.from("point_entries").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
    await s.from("point_balances").delete().eq("member_id", identity.memberId).eq("point_card_id", card.data.id);
    const rewards = await s.from("point_card_rewards").select("ticket_template_id").eq("point_card_id", card.data.id);
    await s.from("point_card_rewards").delete().eq("point_card_id", card.data.id);
    await s.from("point_cards").delete().eq("id", card.data.id);
    for (const row of rewards.data || []) {
      if (row.ticket_template_id) await s.from("ticket_templates").delete().eq("id", row.ticket_template_id).eq("created_by", actorPrefix);
    }
    return { cleaned: true };
  }

  if (surface === "event") {
    const expectedIds = ["QA-UI-EVT-" + tag, "QA-UI-EVT-LOT-" + tag];
    const events = await s.from("event_tickets").select("id,event_ticket_id,created_by").in("event_ticket_id", expectedIds);
    if (events.error) throw new ApiError(500, "QA_FIXTURE_LOOKUP_FAILED", "無法確認活動票券測試資料。");
    const rows = events.data || [];
    if (!rows.length) return { cleaned: true };
    if (rows.some((row: any) => String(row.created_by) !== actorPrefix)) {
      throw new ApiError(403, "QA_FIXTURE_OWNERSHIP_FAILED", "測試資料不屬於目前測試會員。");
    }
    const rowIds = rows.map((row: any) => row.id);
    await s.from("event_ticket_claims").delete().in("event_ticket_id", rowIds).eq("member_id", identity.memberId);
    await s.from("calendar_items").delete().in("source_event_ticket_id", rowIds);
    await s.from("event_tickets").delete().in("id", rowIds);
    const remaining = await s.from("event_tickets").select("id", { count: "exact", head: true }).in("id", rowIds);
    if (remaining.error || Number(remaining.count || 0) !== 0) throw new ApiError(500, "QA_FIXTURE_CLEANUP_FAILED", "活動票券測試資料清理失敗。");
    return { cleaned: true, cleanedEventTickets: rows.length };
  }

  if (surface === "calendar") {
    const item = await s.from("calendar_items").select("id,created_by").eq("calendar_item_id", "QA-UI-CAL-" + tag).maybeSingle();
    if (item.error) throw new ApiError(500, "QA_FIXTURE_LOOKUP_FAILED", "無法確認日曆測試資料。");
    if (!item.data) return { cleaned: true };
    if (String(item.data.created_by) !== actorPrefix) throw new ApiError(403, "QA_FIXTURE_OWNERSHIP_FAILED", "測試資料不屬於目前測試會員。");
    await s.from("calendar_items").delete().eq("id", item.data.id);
    return { cleaned: true };
  }

  return { cleaned: true };
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

function safeDiagnosticSnapshot(value: unknown, maxChars = 7000): Json {
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
    const out: Json = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>).slice(0, 60)) {
      out[key] = blocked.test(key) ? "[redacted]" : redact(item, depth + 1) as any;
    }
    return out;
  };
  const sanitized = redact(value) as Json;
  let serialized = "";
  try { serialized = JSON.stringify(sanitized ?? {}); } catch { return { serializationFailed: true }; }
  if (serialized.length <= maxChars) return sanitized ?? {};
  const compacted: Json = {
    truncated: true,
    originalChars: serialized.length,
    artifactVersion: sanitized.artifactVersion,
    seed: sanitized.seed,
    surface: sanitized.surface,
    caseKey: sanitized.caseKey,
    page: sanitized.page,
    elapsedMs: sanitized.elapsedMs,
    error: sanitized.error,
    screenshot: sanitized.screenshot,
    diagnosis: sanitized.diagnosis,
    apiTimings: Array.isArray(sanitized.apiTimings) ? sanitized.apiTimings.slice(-8) : [],
    events: Array.isArray(sanitized.events) ? sanitized.events.slice(-6).map((event: any) => ({
      atMs: event.atMs, type: event.type, detail: { target: event.detail?.target, message: event.detail?.message, code: event.detail?.code },
    })) : [],
  };
  while (JSON.stringify(compacted).length > maxChars && ((compacted.events as any[]).length || (compacted.apiTimings as any[]).length)) {
    if ((compacted.events as any[]).length) (compacted.events as any[]).shift();
    else (compacted.apiTimings as any[]).shift();
  }
  return compacted;
}

function normalizeE2EGpsFixture(raw: unknown, startedAt: string, completedAt: string): Json {
  // Browser GPS evidence is untrusted test-only data. Never use it for eligibility,
  // authorization, ticket redemption, geofencing, or a production member session.
  const unavailable = (status: string, reason: string): Json =>
    ({ source: "browser-geolocation", testOnly: true, status, reason });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailable("unavailable", "GPS_NOT_RECORDED");
  const input = raw as Record<string, unknown>;
  if (input.source !== "browser-geolocation" || input.testOnly !== true) return unavailable("invalid", "GPS_SOURCE_INVALID");
  const status = String(input.status || "");
  const failures = ["denied", "timeout", "unavailable", "invalid"];
  if (failures.includes(status)) {
    const reason = String(input.reason || "").slice(0, 80);
    return unavailable(status, /^[A-Z_]{3,80}$/.test(reason) ? reason : "GPS_UNAVAILABLE");
  }
  if (status !== "ready" && status !== "imprecise") return unavailable("invalid", "GPS_STATUS_INVALID");
  const latitude = Number(input.latitude), longitude = Number(input.longitude);
  const accuracyMeters = Number(input.accuracyMeters);
  const capturedMs = Date.parse(String(input.capturedAt || ""));
  const startMs = Date.parse(startedAt), endMs = Date.parse(completedAt);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude)
    || Math.abs(longitude) > 180 || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0
    || accuracyMeters > 10000 || !Number.isFinite(capturedMs)
    || capturedMs < startMs - 120000 || capturedMs > endMs + 30000) {
    return unavailable("invalid", "GPS_COORDINATES_OR_TIME_INVALID");
  }
  if (status === "ready" && accuracyMeters > 100) return unavailable("invalid", "GPS_ACCURACY_INVALID");
  return {
    source: "browser-geolocation", testOnly: true, status,
    latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)),
    accuracyMeters: Math.round(accuracyMeters), capturedAt: new Date(capturedMs).toISOString(),
    expiresAt: new Date(capturedMs + 120000).toISOString()
  };
}

async function persistBrowserQaRun(s: any, identity: any, surface: Surface, rawCases: unknown, timing: Json = {}): Promise<Json> {
  const cases = Array.isArray(rawCases) ? rawCases : [];
  if (cases.length > 60) throw new ApiError(400,"INVALID_BROWSER_CASES","會員 E2E 案例不可超過 60 個，拒絕截斷測試證據。");
  if (!cases.length) throw new ApiError(400, "QA_BROWSER_CASES_REQUIRED", "沒有可記錄的瀏覽器測試案例。");
  const normalized = cases.map((raw: any, index: number) => {
    const status = ["passed","failed","skipped"].includes(String(raw?.status)) ? String(raw.status) : "failed";
    const key = asText(raw?.key, 100) || ("BROWSER_" + String(index + 1).padStart(2, "0"));
    const name = asText(raw?.name, 180) || "真人操作測試";
    const domain = asText(raw?.domain, 100) || "UI";
    const message = asText(raw?.message, 1000);
    const expected = raw?.expected && typeof raw.expected === "object" ? raw.expected : {};
    const actual = raw?.actual && typeof raw.actual === "object" ? raw.actual : {};
    const trace = status === "failed" ? safeDiagnosticSnapshot(raw?.trace) : {};
    const diagnosis = status === "failed"
      ? diagnoseE2EFailure({ caseKey: key, domain, message, expected, actual, trace })
      : null;
    return {
      key, name, domain, status, message, expected, actual, diagnosis,
      trace: diagnosis ? attachE2EDiagnosis(trace, diagnosis) : trace,
      durationMs: Math.max(0, Math.min(300000, Number(raw?.durationMs || 0))),
    };
  });
  const { startedAt, completedAt, durationMs } = browserRunWindow(timing);
  const now = completedAt;
  const failedCount = normalized.filter((item) => item.status === "failed").length;
  const passedCount = normalized.filter((item) => item.status === "passed").length;
  const skippedCount = normalized.filter((item) => item.status === "skipped").length;
  const featureCoverage = normalizeFeatureCoverage(timing.featureCoverage);
  const suite = timing.suite === "quick" ? "quick" : "full";
  const gpsTestFixture = normalizeE2EGpsFixture(timing.gpsTestFixture, startedAt, completedAt);
  const gpsRequired = suite === "full" && ["booking","points","event"].includes(surface);
  const gpsIncomplete = gpsRequired && gpsTestFixture.status !== "ready";
  const rawExpectedKeys = Array.isArray(timing.expectedCaseKeys) ? timing.expectedCaseKeys : [];
  const expectedKeys = rawExpectedKeys.slice(0,60).filter((key: unknown) => typeof key === "string" && /^[A-Z0-9_]{1,100}$/.test(key));
  const missingKeys = expectedKeys.filter((key: string) => !normalized.some(row => row.key === key && row.status === "passed")
    || normalized.some(row => row.key === key && row.status !== "passed"));
  const executionIncomplete = gpsIncomplete || (suite === "full" && (!featureCoverage?.complete || expectedKeys.length === 0
    || expectedKeys.length !== rawExpectedKeys.length || new Set(expectedKeys).size !== expectedKeys.length || missingKeys.length > 0));
  const runCode = "UE2E-" + Date.now().toString(36).toUpperCase() + "-" + suffix().slice(0, 8);
  const run = await s.from("automation_test_runs").insert({
    run_code: runCode,
    suite,
    environment: "MemberWebsocket-dev",
    status: failedCount || executionIncomplete ? "failed" : "passed",
    triggered_by: identity.lineUserId,
    total_cases: normalized.length,
    passed_cases: passedCount,
    failed_cases: failedCount,
    summary: {
      runnerVersion: /^20\d{2}-\d{2}-\d{2}\.\d{1,3}$/.test(String(timing.runnerVersion || ""))
        ? timing.runnerVersion : "legacy-unreported",
      source: "member-client-browser",
      surface,
      ...summarizeE2EExecution(normalized),
      featureCoverage,
      gpsTestFixture,
      missingCaseKeys: missingKeys,
      ...(executionIncomplete ? {coverageComplete:false,verificationStatus:failedCount ? "failed" : "incomplete"} : {}),
      skippedCases: skippedCount,
      memberId: identity.memberId,
      diagnosticsVersion: 3,
      failureDiagnostics: summarizeE2EFailureDiagnoses(
        normalized.map((item) => item.diagnosis).filter(Boolean),
      ),
    },
    started_at: startedAt,
    completed_at: completedAt,
    updated_at: now,
  }).select("id").single();
  if (run.error || !run.data) throw new ApiError(503, "QA_RECORD_WRITE_FAILED", "無法建立真人操作測試紀錄。");
  const runId = String(run.data.id);
  try {
    const inserted = await s.from("automation_test_cases").insert(normalized.map((item, index) => ({
      run_id: runId,
      case_order: index + 1,
      case_key: item.key,
      name: item.name,
      domain: "Human E2E / " + surface + " / " + item.domain,
      member_id: identity.memberId,
      status: item.status,
      failure_code: item.status === "failed" ? item.diagnosis?.code || "UI_E2E_FAILED" : null,
      failure_message: item.status === "failed" ? item.message : null,
      started_at: now,
      completed_at: now,
      duration_ms: Math.trunc(item.durationMs),
      updated_at: now,
    }))).select("id,case_key");
    if (inserted.error) throw new ApiError(503, "QA_RECORD_CASE_WRITE_FAILED", "無法寫入真人操作測試案例。");
    const ids = new Map((inserted.data || []).map((row: any) => [String(row.case_key), String(row.id)]));
    const steps = normalized.flatMap((item) => {
      const caseId = ids.get(item.key);
      if (!caseId) return [];
      const rows: any[] = [{
        case_id: caseId,
        step_order: 1,
        step_key: "human-ui",
        name: "模擬真人 UI 操作",
        status: item.status,
        expected: item.expected,
        actual: item.actual,
        message: item.message,
        started_at: now,
        completed_at: now,
        duration_ms: Math.trunc(item.durationMs),
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
          message: "失敗案例保留診斷分類、穩定指紋、seed、surface、browser lifecycle、Realtime signal 與 API timing。",
          started_at: now,
          completed_at: now,
          duration_ms: 0,
          updated_at: now,
        });
      }
      return rows;
    });
    const stepInsert = await s.from("automation_test_steps").insert(steps);
    if (stepInsert.error) throw new ApiError(503, "QA_RECORD_STEP_WRITE_FAILED", "無法寫入真人操作測試步驟。");
  } catch (error) {
    await s.from("automation_test_runs").delete().eq("id", runId);
    throw error;
  }
  const learningRefresh = await s.rpc("admin_accumulate_e2e_case_learning", { p_run_id: runId });
  if (learningRefresh.error) {
    console.error("User browser E2E case learning refresh failed", learningRefresh.error.message);
  }
  return { runId, runCode, recorded: normalized.length };
}

async function runSurfaceCases(s: any, identity: any, token: string, surface: Surface): Promise<QaCase[]> {
  let cases: QaCase[];
  if (surface === "member") cases = [await memberProfileWrite(s, identity, token)];
  else if (surface === "points") cases = [await pointTicketWrite(s, identity, token)];
  else if (surface === "event") cases = [await eventTicketWrite(s, identity, token)];
  else if (surface === "calendar") cases = [await calendarReadOnly(s, identity, token)];
  else cases = [
    await bookingWrite(s, identity, token),
    await bookingGroupWrite(s, identity, token),
  ];
  cases.push(await lineSuppression(s));
  return cases;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return failReply(origin, new ApiError(405, "METHOD_NOT_ALLOWED", "只支援 POST。"));
  if (origin && !allowedOrigins().has(origin)) return failReply(origin, new ApiError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未被允許使用用戶端 QA 服務。"));

  try {
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);
    const action = asText(body.action, 80);
    if (!["user.qa.mutations","user.qa.usage-state.prepare","user.qa.fixture.prepare","user.qa.fixture.cleanup","user.qa.event-day.prepare","user.qa.browser-run.record"].includes(action)) {
      throw new ApiError(404, "ACTION_NOT_FOUND", "不支援的 QA 操作。");
    }
    const surface = asText(body.surface, 20) as Surface;
    if (!SURFACES.has(surface)) throw new ApiError(400, "INVALID_SURFACE", "不支援的用戶端測試頁面。");

    const token = asText(body.testSessionToken, 200);
    if (!token) throw new ApiError(401, "TEST_SESSION_REQUIRED", "需要有效的測試帳號 Session。");

    const s = db();
    let identity;
    try {
      identity = await resolveTestSession(s, token);
    } catch (error) {
      if (error instanceof TestModeAuthError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
    if (identity.isTestAccount !== true) throw new ApiError(403, "TEST_ACCOUNT_REQUIRED", "此功能只允許測試帳號使用。");
    // QA actions can create and remove fixtures. Bind the requested surface to
    // the authenticated test session before dispatching any action.
    if (identity.surface !== surface) {
      throw new ApiError(409, "TEST_SESSION_SURFACE_MISMATCH", "此測試登入屬於其他用戶端，請重新選擇測試帳號。");
    }

    if (action === "user.qa.event-day.prepare") {
      if (surface !== "event") throw new ApiError(403,"EVENT_SURFACE_REQUIRED","請從活動票券測試使用。");
      const fixtureTag = requireFixtureTag(body.fixtureTag);
      const prepared = await s.rpc("prepare_e2e_event_redemption_day",{p_member_id:identity.memberId,p_fixture_tag:fixtureTag});
      if (prepared.error) throw new ApiError(503,"QA_EVENT_DAY_PREPARE_FAILED","無法準備測試帳號的票券日期狀態。");
      return reply(origin,{ok:true,status:200,data:prepared.data});
    }
    if (action === "user.qa.usage-state.prepare") {
      const usageState = await prepareUsageState(s, identity, token, surface);
      return reply(origin, { ok: true, status: 200, data: { surface, ...usageState } });
    }
    if (action === "user.qa.fixture.prepare") {
      const fixture = await prepareHumanFixture(s, identity, surface);
      return reply(origin, { ok: true, status: 200, data: { surface, ...fixture } });
    }
    if (action === "user.qa.fixture.cleanup") {
      const cleanup = await cleanupHumanFixture(s, identity, surface, body);
      return reply(origin, { ok: true, status: 200, data: { surface, ...cleanup } });
    }
    if (action === "user.qa.browser-run.record") {
      const record = await persistBrowserQaRun(s, identity, surface, body.cases, body);
      return reply(origin, { ok: true, status: 200, data: { surface, ...record } });
    }

    const cases = await runSurfaceCases(s, identity, token, surface);
    const recordedRun = await persistUserQaRun(s, identity, surface, cases);
    return reply(origin, {
      ok: true,
      status: 200,
      data: {
        surface,
        cases,
        runId: recordedRun.runId,
        runCode: recordedRun.runCode,
        recordPersisted: true,
      },
    });
  } catch (error) {
    return failReply(origin, error);
  }
});
