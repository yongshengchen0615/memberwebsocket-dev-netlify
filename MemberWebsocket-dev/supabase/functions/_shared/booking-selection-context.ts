import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.0";

// All queries are scoped to the authenticated member, never a supplied owner id.
export async function loadMemberBookingSelections(db: SupabaseClient, memberId: string) {
  const [bookings, selections] = await Promise.all([
    db.from('bookings').select('id,booking_date,start_time,end_time,start_at,end_at,status,updated_at,completed_at,cancellation_requested_at,cancellation_reviewed_at,receipt_submission_id')
      .eq('member_id', memberId).in('status', ['pending', 'confirmed'])
      .order('booking_date', { ascending: false }).order('id').limit(100),
    db.from('booking_benefit_selections').select('booking_id,benefit_kind,benefit_ref,title_snapshot,status')
      .eq('member_id', memberId).in('status', ['pending', 'redeemed', 'applied']),
  ]);
  if (bookings.error) throw bookings.error;
  if (selections.error) throw selections.error;
  const ids = (bookings.data || []).map(row => row.id);
  const slots = ids.length ? await db.from('booking_participant_reservations')
    .select('booking_id,participant_id,start_at,end_at,start_time,end_time,booking_date')
    .in('booking_id', ids).order('start_at') : { data: [], error: null };
  if (slots.error) throw slots.error;
  return (bookings.data || []).map(row => {
    const cancellationPending = Boolean(row.cancellation_requested_at && !row.cancellation_reviewed_at);
    const editable = !row.completed_at && !row.receipt_submission_id && !cancellationPending;
    return {
      bookingId: row.id, bookingDate: row.booking_date,
      startTime: String(row.start_time).slice(0, 5), endTime: String(row.end_time).slice(0, 5),
      startAt: row.start_at, endAt: row.end_at, status: row.status, updatedAt: row.updated_at,
      editable, disabledReason: cancellationPending ? '預約正在申請取消'
        : row.receipt_submission_id ? '快照票券請依原快照審核流程處理' : row.completed_at ? '已完成結算' : '',
      serviceSlots: (slots.data || []).filter(slot => slot.booking_id === row.id).map(slot => ({
        participantId: slot.participant_id, bookingDate: slot.booking_date,
        startAt: slot.start_at, endAt: slot.end_at,
        startTime: String(slot.start_time).slice(0, 5), endTime: String(slot.end_time).slice(0, 5),
      })),
      selections: (selections.data || []).filter(s => s.booking_id === row.id).map(s => ({
        kind: s.benefit_kind, id: s.benefit_ref, title: s.title_snapshot, status: s.status,
      })),
    };
  });
}

export function contextsForTicket(bookings: any[], kind: string, ref: string) {
  return bookings.filter(b => b.selections.some((s: any) => s.kind === kind && s.id === ref)).map(b => ({
    bookingId: b.bookingId, bookingDate: b.bookingDate, startTime: b.startTime, endTime: b.endTime,
    startAt: b.startAt, endAt: b.endAt, serviceSlots: b.serviceSlots,
    editable: b.editable, disabledReason: b.disabledReason,
    status: b.selections.find((s: any) => s.kind === kind && s.id === ref)?.status,
  }));
}
