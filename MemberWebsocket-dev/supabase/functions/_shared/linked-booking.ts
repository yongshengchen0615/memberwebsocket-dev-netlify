// Identity and active role are verified before this helper. Member scope always
// comes from the server's authenticated member, never the request payload.
export async function linkedBooking(db:any,bookingId:string,memberId:string|null):Promise<any|null> {
  if(!bookingId) return null;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId)) throw new Error('INVALID_BOOKING_ID');
  let query=db.from('bookings').select('*,members!bookings_member_id_fkey(display_name,member_code)').eq('id',bookingId);
  if(memberId!==null) query=query.eq('member_id',memberId);
  const result=await query.maybeSingle();
  if(result.error) throw new Error('BOOKING_DETAIL_UNAVAILABLE');
  if(!result.data) throw new Error('BOOKING_NOT_FOUND');
  return result.data;
}
