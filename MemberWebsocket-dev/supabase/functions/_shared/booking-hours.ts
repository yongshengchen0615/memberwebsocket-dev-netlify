// Booking dates are business dates in Asia/Taipei. Keep local timestamps separate
// from UTC instants so the day after midnight stays attached to its opening shift.
export function minutes(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::00)?$/.exec(String(value || ""));
  if (!match) throw new Error("INVALID_WORK_HOURS");
  const result = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("INVALID_WORK_HOURS");
  return result;
}

export function workWindow(start: string, end: string): { start: number; end: number; overnight: boolean } {
  const opening = minutes(start);
  const closing = minutes(end);
  if (opening === closing) throw new Error("INVALID_WORK_HOURS");
  return { start: opening, end: closing <= opening ? closing + 1440 : closing, overnight: closing < opening };
}

export function currentBusinessDate(today: string, currentMinutes: number, open: string, close: string): string {
  if (workWindow(open, close).overnight && currentMinutes < minutes(close)) {
    const day = Date.parse(`${today}T00:00:00Z`);
    return new Date(day - 86_400_000).toISOString().slice(0, 10);
  }
  return today;
}

export function timeOnBusinessDate(date: string, offset: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(offset) || offset < 0 || offset >= 2880) throw new Error("INVALID_BOOKING_SLOT");
  const base = Date.parse(`${date}T00:00:00Z`);
  const value = new Date(base + offset * 60_000);
  if (!Number.isFinite(base) || value.getUTCFullYear() < 2000) throw new Error("INVALID_BOOKING_SLOT");
  return `${value.toISOString().slice(0, 16)}:00+08:00`;
}

export function clockTime(offset: number): string {
  const value = offset % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function occupiedRange(row: { start_at: string; end_at: string }): { start: number; end: number } {
  // PostgREST serializes timestamp without time zone without an offset.
  const start = Date.parse(`${String(row.start_at).replace(" ", "T").replace(/Z|[+-]\d\d:?\d\d$/, "")}Z`);
  const end = Date.parse(`${String(row.end_at).replace(" ", "T").replace(/Z|[+-]\d\d:?\d\d$/, "")}Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("INVALID_BOOKING_RANGE");
  return { start, end };
}

export function localTimestamp(value: unknown): string {
  return value ? `${String(value).replace(" ", "T").replace(/Z|[+-]\d\d:?\d\d$/, "").slice(0, 19)}+08:00` : "";
}

export function localRange(date: string, start: number, duration: number): { start: number; end: number } {
  const base = Date.parse(`${date}T00:00:00Z`);
  return { start: base + start * 60_000, end: base + (start + duration) * 60_000 };
}

export function slotHasPassed(date: string, start: number, now = Date.now()): boolean {
  return Date.parse(timeOnBusinessDate(date, start)) <= now;
}
