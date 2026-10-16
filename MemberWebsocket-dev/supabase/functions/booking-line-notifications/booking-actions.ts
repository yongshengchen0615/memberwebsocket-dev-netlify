import "../../../booking-copy-text.js";
const STORE = '00000000-0000-4000-8000-000000000010';
export async function loadAdminCopyText(db: any, bookingId: string): Promise<{copyText:string;status:string}> {
  const [booking, participants] = await Promise.all([
    db.from('bookings').select('*,members!bookings_member_id_fkey(surname,salutation,phone)').eq('id',bookingId).single(),
    db.from('booking_participants').select('id,position,booking_technicians(name)').eq('booking_id',bookingId).order('position',{ascending:true}),
  ]);
  if(booking.error || participants.error) throw new Error('BOOKING_COPY_UNAVAILABLE');
  const b=booking.data, people=participants.data || [], ids=people.map((p:any)=>p.id);
  const source=ids.length ? await db.from('booking_participant_items').select('participant_id,service_id,service_title,quantity').in('participant_id',ids).order('created_at',{ascending:true})
    : await db.from('booking_items').select('service_id,service_title,quantity').eq('booking_id',bookingId).order('created_at',{ascending:true});
  if(source.error) throw new Error('BOOKING_COPY_UNAVAILABLE');
  const items=(source.data || []).filter((x:any)=>x.service_id!==STORE);
  const mapItem=(x:any)=>({serviceTitle:x.service_title,quantity:x.quantity});
  const group=ids.length ? people.map((p:any)=>({technicianName:p.booking_technicians?.name || '現場安排',items:items.filter((x:any)=>x.participant_id===p.id).map(mapItem)}))
    : [{technicianName:'現場安排',items:items.map(mapItem)}];
  const fallback=b.contact_source==='member' ? b.members || {} : {};
  const surname=String(b.contact_surname || fallback.surname || '').trim();
  const salutation=b.contact_salutation || fallback.salutation;
  const label=salutation==='mr' ? '先生' : salutation==='ms' ? '小姐' : '';
  const format=(globalThis as any).BookingCopyText.format;
  return {status:b.status,copyText:format({bookingDate:b.booking_date,startAt:b.start_at,endAt:b.end_at,startTime:b.start_time,endTime:b.end_time,
    name:surname && label ? surname+label : '未取得預約人資料',phone:b.contact_phone || fallback.phone || '—',partySize:group.length,participants:group})};
}
export function bookingDetailUri(bookingId: string, admin=false, action=''): string {
  const liff=admin ? '2010791619-vhevCvvD' : '2010787602-sgiB0ETj';
  const params=new URLSearchParams({bookingId});
  if(admin && action) params.set('bookingAction',action);
  return `https://liff.line.me/${liff}?${params}`;
}
