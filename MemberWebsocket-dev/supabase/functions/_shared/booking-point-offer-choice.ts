// A reward is shown once per booking; physical ticket IDs remain unique
// redemption slots so completion of one booking does not consume another's.
export function chooseBookingPointOffers<T extends {
  rewardId: string;
  pointCardId: string;
  ticketId?: string;
}>(
  offers: T[],
  selections: Array<{ booking_id?: string; benefit_kind?: string; benefit_ref?: string }>,
  currentBookingId = '',
): T[] {
  const bookedByTicket = new Map<string, string>();
  for (const row of selections) {
    if (row.benefit_kind !== 'points' || !row.benefit_ref) continue;
    bookedByTicket.set(String(row.benefit_ref), String(row.booking_id || ''));
  }
  const visible = new Map<string, T>();
  const rank = (offer: T) => {
    const bookingId = bookedByTicket.get(String(offer.ticketId || ''));
    if (!bookingId) return 1; // unreserved instance for a different booking
    return currentBookingId && bookingId === currentBookingId ? 2 : 0;
  };
  for (const offer of offers) {
    const key = `${offer.pointCardId}:${offer.rewardId}`;
    const previous = visible.get(key);
    if (!previous || rank(offer) > rank(previous)) visible.set(key, offer);
  }
  return [...visible.values()];
}
