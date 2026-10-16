import { readJsonObject } from "../_shared/request-body.ts";
import { resolveUserTestIdentity, TestModeAuthError } from "../_shared/test-mode-auth.ts";
import {
  ApiError,
  asText,
  authorizeAdmin,
  ClientType,
  consumeRateLimit,
  corsHeaders,
  dbClient,
  Identity,
  Json,
  MAX_REQUEST_BYTES,
  originAllowed,
  requireJoinedMember,
  response,
  verifyLineIdToken,
} from "./shared.ts";
import {
  contactsForIds,
  hydrateBooking,
  mapDbError,
  normalizeItems,
  normalizeTime,
  requestContact,
  requireDate,
  requireUuid,
} from "./booking.ts";

async function audit(supabase: any, identity: Identity, action: string, bookingId: string, metadata: Json): Promise<void> {
  const result = await supabase.from("booking_audit_events").insert({
    actor_line_user_id: identity.lineUserId,
    actor_role: "member",
    action,
    target_type: "booking",
    target_id: bookingId,
    result: "success",
    metadata,
  });
  if (result.error) console.error("booking contact audit insert failed", result.error.message);
}

async function handleMemberWrite(supabase: any, identity: Identity, member: any, action: string, body: Json): Promise<Json> {
  const requestId = asText(body.requestId, 100);
  if (!/^BOOK-[A-Za-z0-9-]{8,95}$/.test(requestId)) {
    throw new ApiError(400, "INVALID_REQUEST_ID", "操作識別碼格式不正確。");
  }

  const bookingDate = requireDate(body.bookingDate);
  const startTime = normalizeTime(body.startTime);
  const items = normalizeItems(body.items);
  const memberNote = asText(body.memberNote, 500);
  const contact = requestContact(body);

  let rpc;
  if (action === "user.booking.create") {
    rpc = await supabase.rpc("create_booking_bundle_with_contact", {
      p_request_id: requestId,
      p_member_id: member.id,
      p_booking_date: bookingDate,
      p_start_time: `${startTime}:00`,
      p_items: items,
      p_member_note: memberNote,
      ...contact,
    });
  } else {
    const expectedUpdatedAt = asText(body.expectedUpdatedAt, 80);
    if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      throw new ApiError(400, "INVALID_INPUT", "缺少預約版本，請重新整理。");
    }
    rpc = await supabase.rpc("update_booking_bundle_with_contact", {
      p_booking_id: requireUuid(body.bookingId),
      p_expected_updated_at: expectedUpdatedAt,
      p_actor: identity.lineUserId,
      p_request_id: requestId,
      p_member_id: member.id,
      p_booking_date: bookingDate,
      p_start_time: `${startTime}:00`,
      p_items: items,
      p_member_note: memberNote,
      ...contact,
    });
  }

  if (rpc.error) throw mapDbError(rpc.error);
  const row: any = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  if (!row?.id) throw new ApiError(500, "BOOKING_SAVE_FAILED", "無法確認預約儲存結果。");

  const booking = await hydrateBooking(supabase, String(row.id));
  await audit(
    supabase,
    identity,
    action === "user.booking.create" ? "BOOKING_REQUESTED_WITH_CONTACT" : "BOOKING_UPDATED_WITH_CONTACT",
    String(row.id),
    { contactSource: booking.contactSource, bookingDate, startTime },
  );
  return { booking };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") {
    return response(origin, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支援 POST。" } }, 405);
  }
  if (!originAllowed(origin)) {
    return response(origin, { ok: false, error: { code: "ORIGIN_DENIED", message: "不允許的來源。" } }, 403);
  }

  try {
    const body = await readJsonObject(request, MAX_REQUEST_BYTES, ApiError);

    const action = asText(body.action, 80);
    const clientType = asText(body.clientType, 20) as ClientType;
    if (!["member", "admin"].includes(clientType)) {
      throw new ApiError(400, "INVALID_CLIENT_TYPE", "不支援的操作端。");
    }
    if (clientType === "member" && !["user.booking.create", "user.booking.update", "user.booking.contacts"].includes(action)) {
      throw new ApiError(403, "CLIENT_ACTION_MISMATCH", "操作端與功能不相符。");
    }
    if (clientType === "admin" && action !== "admin.booking.contacts") {
      throw new ApiError(403, "CLIENT_ACTION_MISMATCH", "操作端與功能不相符。");
    }

    const supabase = dbClient();
    let identity: Identity;
    if (clientType === "member") {
      try {
        const testIdentity = await resolveUserTestIdentity(supabase, asText(body.testSessionToken, 200));
        identity = testIdentity
          ? { lineUserId: testIdentity.lineUserId, displayName: testIdentity.displayName }
          : await verifyLineIdToken(asText(body.idToken, 10_000), clientType);
      } catch (error) {
        if (error instanceof TestModeAuthError) throw new ApiError(error.status, error.code, error.message);
        throw error;
      }
    } else {
      identity = await verifyLineIdToken(asText(body.idToken, 10_000), clientType);
    }
    await consumeRateLimit(supabase, identity, action);

    if (clientType === "admin") {
      await authorizeAdmin(supabase, identity);
      const ids = Array.isArray(body.bookingIds) ? body.bookingIds.slice(0, 100).map(requireUuid) : [];
      return response(origin, { ok: true, status: 200, data: { contacts: await contactsForIds(supabase, ids) } });
    }

    const member = await requireJoinedMember(supabase, identity);
    if (action === "user.booking.contacts") {
      const ids = Array.isArray(body.bookingIds) ? body.bookingIds.slice(0, 100).map(requireUuid) : [];
      return response(origin, { ok: true, status: 200, data: { contacts: await contactsForIds(supabase, ids, member.id) } });
    }

    const data = await handleMemberWrite(supabase, identity, member, action, body);
    return response(origin, { ok: true, status: 200, data });
  } catch (error) {
    const apiError = error instanceof ApiError ? error : mapDbError(error);
    return response(origin, {
      ok: false,
      status: apiError.status,
      error: { code: apiError.code, message: apiError.message, details: apiError.details },
    }, apiError.status);
  }
});

