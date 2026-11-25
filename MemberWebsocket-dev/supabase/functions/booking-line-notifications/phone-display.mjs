// Presentation-only normalization for structured phone fields in LINE booking
// notices. The outbox payload, stored member phone and recipient remain intact.
export function formatBookingLinePhoneFields(message, formatPhone) {
  if (typeof formatPhone !== 'function') throw new TypeError('BOOKING_PHONE_FORMATTER_REQUIRED');
  return String(message ?? '').replace(
    /^([ \t]*(?:電話|聯絡電話|聯絡手機|手機)[：:][ \t]*)([^\r\n]*)/gm,
    (line, label, value) => {
      const displayed = formatPhone(value);
      return /^09\d{8}$/.test(displayed) ? label + displayed : line;
    },
  );
}
