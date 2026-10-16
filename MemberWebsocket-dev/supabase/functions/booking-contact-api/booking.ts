import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";
import { ApiError, asText, Json } from "./shared.ts";

export function requireUuid(value: unknown): string {
  const text = asText(value, 60);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new ApiError(400, "INVALID_INPUT", "預約識別格式不正確。");
  }
  return text;
}

export function requireDate(value: unknown): string {
  const text = asText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ApiError(400, "INVALID_DATE", "請選擇正確的預約日期。");
  }
  return text;
}

export function normalizeTime(value: unknown): string {
  const text = asText(value, 8);
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match || Number(match[1]) > 23 || ![0, 30].includes(Number(match[2]))) {
    throw new ApiError(400, "INVALID_TIME", "時間格式不正確。");
  }
  return `${match[1]}:${match[2]}`;
}

export function normalizeItems(value: unknown): Array<{ serviceId: string; quantity: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new ApiError(400, "INVALID_BOOKING_ITEMS", "請至少選擇一個預約項目。");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const row = raw && typeof raw === "object" ? raw as Json : {};
    const serviceId = requireUuid(row.serviceId);
    const quantity = Number(row.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2) {
      throw new ApiError(400, "INVALID_BOOKING_QUANTITY", "每個預約項目的數量只能選擇 1 或 2。");
    }
    if (seen.has(serviceId)) throw new ApiError(400, "DUPLICATE_BOOKING_SERVICE", "同一個預約項目只能選擇一次。");
    seen.add(serviceId);
    return { serviceId, quantity };
  });
}

export function mapDbError(error: any): ApiError {
  const message = `${error?.message || ""} ${error?.details || ""}`;
  const rules: Array<[string, number, string, string]> = [
    ["BOOKING_CONFLICT", 409, "BOOKING_CONFLICT", "預約已被更新，請重新整理後再操作。"],
    ["BOOKING_NOT_EDITABLE", 409, "BOOKING_NOT_EDITABLE", "這筆預約目前無法修改。"],
    ["BOOKING_SLOT_TAKEN", 409, "BOOKING_SLOT_TAKEN", "這段時間剛剛已被其他會員預約，請選擇其他時間。"],
    ["BOOKING_TOO_EARLY", 409, "BOOKING_TOO_EARLY", "尚未符合提前預約天數。"],
    ["BOOKING_TIME_PASSED", 409, "BOOKING_TIME_PASSED", "這個預約時間已經過了。"],
    ["BOOKING_SERVICE_DISABLED", 409, "BOOKING_SERVICE_DISABLED", "其中一個預約項目目前未開放。"],
    ["BOOKING_SERVICE_NOT_FOUND", 404, "BOOKING_SERVICE_NOT_FOUND", "找不到其中一個預約項目。"],
    ["REQUEST_ID_CONFLICT", 409, "REQUEST_ID_CONFLICT", "操作識別碼衝突，請重新操作。"],
    ["INVALID_BOOKING_CONTACT_SOURCE", 400, "INVALID_BOOKING_CONTACT_SOURCE", "請選擇預約資料來源。"],
    ["INVALID_BOOKING_CONTACT_SURNAME", 400, "INVALID_BOOKING_CONTACT_SURNAME", "請填寫預約姓氏。"],
    ["INVALID_BOOKING_CONTACT_SALUTATION", 400, "INVALID_BOOKING_CONTACT_SALUTATION", "請選擇先生或小姐。"],
    ["INVALID_BOOKING_CONTACT_PHONE", 400, "INVALID_BOOKING_CONTACT_PHONE", "請填寫正確的預約電話。"],
    ["MEMBERSHIP_REQUIRED", 403, "MEMBERSHIP_REQUIRED", "請先加入會員並完成會員資料後再使用預約功能。"],
    ["MEMBER_DISABLED", 403, "MEMBER_DISABLED", "此會員目前已停用，無法預約。"],
  ];
  for (const [needle, status, code, userMessage] of rules) {
    if (message.includes(needle)) return new ApiError(status, code, userMessage);
  }
  if (error?.code === "23P01" || error?.code === "23505") {
    return new ApiError(409, "BOOKING_SLOT_TAKEN", "這段時間已被預約，請選擇其他時間。");
  }
  return new ApiError(500, "DATABASE_ERROR", "資料庫暫時無法完成預約操作。");
}

function itemClient(row: any): Json {
  const quantity = Number(row.quantity || 1);
  const unitPriceAmount = Number(row.unit_price_amount || 0);
  return {
    serviceId: row.service_id,
    serviceTitle: row.service_title || "預約項目",
    unitDurationMinutes: Number(row.unit_duration_minutes || 0),
    unitPriceAmount,
    quantity,
    subtotalMinutes: Number(row.unit_duration_minutes || 0) * quantity,
    subtotalAmount: unitPriceAmount * quantity,
  };
}

export function contactClient(row: any): Json {
  const source = asText(row.contact_source || "member", 20).toLowerCase() || "member";
  const member = row.members || {};
  const contactSurname = asText(row.contact_surname, 40)
    || (source === "member" ? asText(member.surname, 40) : "");
  const salutation = asText(row.contact_salutation, 10).toLowerCase()
    || (source === "member" ? asText(member.salutation, 10).toLowerCase() : "");
  const contactPhone = asText(row.contact_phone, 30)
    || (source === "member" ? asText(member.phone, 30) : "");
  return {
    bookingId: row.id,
    contactSource: source,
    contactSurname,
    contactSalutation: salutation,
    contactSalutationLabel: salutation === "mr" ? "先生" : salutation === "ms" ? "小姐" : "",
    contactPhone,
  };
}

export async function hydrateBooking(supabase: SupabaseClient, bookingId: string): Promise<Json> {
  const booking = await supabase.from("bookings").select("*, members!bookings_member_id_fkey(display_name,member_code,surname,salutation,phone)").eq("id", bookingId).single();
  if (booking.error) throw mapDbError(booking.error);
  const itemsResult = await supabase.from("booking_items").select("*").eq("booking_id", bookingId).order("created_at", { ascending: true });
  if (itemsResult.error) throw mapDbError(itemsResult.error);

  const row: any = booking.data;
  const items = (itemsResult.data || []).map(itemClient);
  const member = row.members || {};
  return {
    bookingId: row.id,
    requestId: row.request_id,
    serviceId: row.service_id,
    serviceTitle: items.map((item: any) => item.serviceTitle).join(" + ") || "預約項目",
    items,
    totalDurationMinutes: Number(row.total_duration_minutes || 30),
    totalAmount: items.reduce((sum: number, item: any) => sum + Number(item.subtotalAmount || 0), 0),
    memberId: row.member_id,
    memberDisplayName: member.display_name || "",
    memberCode: member.member_code || "",
    bookingDate: row.booking_date,
    startTime: String(row.start_time || "").slice(0, 5),
    endTime: String(row.end_time || "").slice(0, 5),
    status: row.status,
    memberNote: row.member_note || "",
    adminNote: row.admin_note || "",
    completedAt: row.completed_at || null,
    confirmedAt: row.confirmed_at,
    rejectedAt: row.rejected_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...contactClient(row),
  };
}

export async function contactsForIds(supabase: SupabaseClient, bookingIds: string[], memberId = ""): Promise<Json[]> {
  if (!bookingIds.length) return [];
  let query = supabase.from("bookings")
    .select("id,contact_source,contact_surname,contact_salutation,contact_phone,members!bookings_member_id_fkey(surname,salutation,phone)")
    .in("id", bookingIds);
  if (memberId) query = query.eq("member_id", memberId);
  const result = await query;
  if (result.error) throw mapDbError(result.error);
  return (result.data || []).map(contactClient);
}

export function requestContact(body: Json): Json {
  return {
    p_contact_source: asText(body.contactSource || "member", 20).toLowerCase(),
    p_contact_surname: asText(body.contactSurname, 40),
    p_contact_salutation: asText(body.contactSalutation, 10).toLowerCase(),
    p_contact_phone: asText(body.contactPhone, 30),
  };
}
