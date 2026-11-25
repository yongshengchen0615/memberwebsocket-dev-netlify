// Booking contact numbers are local only for Taiwanese mobile numbers.
// Member phone verification and identity storage remain E.164.
export function formatBookingPhone(value: unknown): string {
  const phone = String(value ?? "").trim();
  const compact = phone.replace(/[()\s.\-]/g, "");
  const match = /^(?:\+?8860?9|09)(\d{8})$/.exec(compact);
  return match ? `09${match[1]}` : phone;
}
