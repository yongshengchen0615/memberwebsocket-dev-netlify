import { formatBookingReminderMessage } from './reminder-message.mjs';

type ScopedDb = {
  from: (table: string) => any;
};

async function required<T>(promise: Promise<{data: T; error: unknown}>, label: string): Promise<T> {
  const result = await promise;
  if (result.error || result.data === null || result.data === undefined) {
    throw new Error('REMINDER_DETAILS_UNAVAILABLE_' + label);
  }
  return result.data;
}

// Read through the existing tenant-scoped service-role client, never an unscoped public client.
// Do not accept caller-supplied booking details, member identity or notification template.
export async function loadBookingReminderMessage(db: ScopedDb, bookingId: string): Promise<string> {
  const booking: any = await required(
    db.from('bookings').select('id,member_id,booking_date,start_at,end_at,status,cancellation_requested_at,reminder_enabled,contact_surname,contact_salutation,contact_phone,party_size,member_note,admin_note,technician_id')
      .eq('id', bookingId).single(), 'BOOKING');
  if (booking.status !== 'confirmed' || booking.cancellation_requested_at !== null || booking.reminder_enabled !== true) {
    throw new Error('REMINDER_BOOKING_INELIGIBLE');
  }
  const [member, settings, participants, bookingItems]: [any, any, any[], any[]] = await Promise.all([
    required(db.from('members').select('id,surname,salutation,phone,is_test_account').eq('id', booking.member_id).single(), 'MEMBER'),
    required(db.from('booking_settings').select('reminder_message').eq('id', 1).single(), 'SETTINGS'),
    required(db.from('booking_participants').select('id,position,technician_id').eq('booking_id', bookingId).order('position'), 'PARTICIPANTS'),
    required(db.from('booking_items').select('service_id,service_title,unit_duration_minutes,unit_price_amount,quantity').eq('booking_id', bookingId), 'ITEMS'),
  ]);
  if (member.is_test_account === true) throw new Error('REMINDER_TEST_MEMBER_BLOCKED');
  const participantIds = participants.map(item => item.id);
  const participantItems: any[] = participantIds.length
    ? await required(db.from('booking_participant_items')
      .select('participant_id,service_title,unit_duration_minutes,unit_price_amount,quantity')
      .in('participant_id', participantIds).order('created_at'), 'PARTICIPANT_ITEMS')
    : [];
  const technicianIds = Array.from(new Set(
    [...participants.map(item => item.technician_id), booking.technician_id].filter(Boolean)));
  const technicians: any[] = technicianIds.length
    ? await required(db.from('booking_technicians').select('id,name').in('id', technicianIds), 'TECHNICIANS')
    : [];
  return formatBookingReminderMessage({
    booking, member, participants, bookingItems, participantItems, technicians,
    reminderText: settings.reminder_message,
  });
}
