export function bookingTicketUsageError(error: unknown, createError: (status: number, code: string, message: string) => Error): Error | null {
  const message = String((error as { message?: string })?.message || "");
  const rules: [string, number, string][] = [
    ["BOOKING_NOT_OWNED", 404, "找不到可供本人使用的預約。"],
    ["BOOKING_TICKET_CONFIRMATION_REQUIRED", 409, "請選擇管理員已確認、尚未完成的預約。"],
    ["BOOKING_CANCELLATION_PENDING", 409, "預約正在申請取消，目前不能使用票券。"],
    ["EVENT_TICKET_ALREADY_REGISTERED", 409, "這張活動票券已在一般預約或快照模式登記，不能重複登記。"],
    ["BOOKING_BENEFIT_RESERVED", 409, "票券已預約使用，將於該次服務完成時自動核銷。"],
    ["BOOKING_BENEFIT_SERVICE_REQUIRED", 409, "票券不符合所選預約的服務項目，請更新後重新選擇。"],
    ["BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED", 409, "已核銷票券所需的服務項目不能移除。"],
    ["REQUEST_ID_CONFLICT", 409, "這次操作內容已變更，請重新整理後重試。"],
  ];
  for (const [code, status, text] of rules) if (message.includes(code)) return createError(status, code, text);
  return null;
}

export function ticketBookingId(value: unknown, createError: (status: number, code: string, message: string) => Error): string | null {
  const id = String(value ?? "").trim();
  if (id === 'no-booking') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw createError(400, "BOOKING_TICKET_CONFIRMATION_REQUIRED", "請先選擇管理員已確認、尚未完成的預約。");
  }
  return id;
}
