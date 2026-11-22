// Only enrich a verified member's pending LINE notice after booking creation
// commits. The INSERT trigger cannot see participant rows inserted later.
const STORE_SERVICE = '00000000-0000-4000-8000-000000000010';
const ORDINALS = ['一','二','三','四','五','六','七','八','九','十'];

function safeText(value, limit = 120) {
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return Array.from(cleaned).slice(0, limit).join('');
}

function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function label(position) {
  const n = Number(position);
  return Number.isInteger(n) && n >= 1 && n <= 10
    ? '第' + ORDINALS[n - 1] + '位預約'
    : '第 ' + (Number.isInteger(n) && n > 0 ? n : 1) + ' 位預約';
}

function formatParticipant(person, items, storeMinutes) {
  const services = items.filter(item => item.service_id !== STORE_SERVICE);
  if (!services.length) throw new Error('PENDING_BOOKING_SERVICES_UNAVAILABLE');
  const titles = services.map(item => {
    const title = safeText(item.service_title, 110) || '未命名服務';
    return title + (count(item.quantity) > 1 ? ' × ' + count(item.quantity) : '');
  });
  const serviceText = safeText(titles.join('、'), 260);
  const serviceMinutes = services.reduce((sum, item) =>
    sum + nonNegative(item.unit_duration_minutes) * count(item.quantity), 0);
  const amount = services.reduce((sum, item) =>
    sum + nonNegative(item.unit_price_amount) * count(item.quantity), 0);
  const technician = safeText(person.booking_technicians?.name, 50) || '現場安排';
  const note = safeText(person.member_note, 120);
  return [
    label(person.position),
    '預約項目：' + serviceText,
    '個別時間：' + Math.round(serviceMinutes + storeMinutes) + ' 分鐘',
    '個別金額：NT$' + Math.round(amount).toLocaleString('en-US'),
    '預約技師：' + technician,
    ...(note ? ['個別備註：' + note] : []),
  ].join('\n');
}

export async function loadMemberPendingBookingDetails(db, bookingId) {
  // All reads use the tenant-scoped service client. Recipient ownership and
  // pending status are validated by the caller before entering this function.
  const [participants, bookingItems] = await Promise.all([
    db.from('booking_participants')
      .select('id,position,member_note,booking_technicians(name)')
      .eq('booking_id', bookingId).order('position', { ascending: true }),
    db.from('booking_items')
      .select('service_id,service_title,quantity,unit_duration_minutes,unit_price_amount')
      .eq('booking_id', bookingId).order('created_at', { ascending: true }),
  ]);
  if (participants.error || bookingItems.error) throw new Error('PENDING_BOOKING_DETAILS_UNAVAILABLE');
  const people = participants.data || [];
  const allBookingItems = bookingItems.data || [];
  const storeMinutes = allBookingItems
    .filter(item => item.service_id === STORE_SERVICE)
    .reduce((sum, item) => sum + nonNegative(item.unit_duration_minutes) * count(item.quantity), 0);

  if (!people.length) {
    // Pre-group bookings did not have booking_participants rows.
    return formatParticipant({ position: 1 }, allBookingItems, storeMinutes);
  }
  const ids = people.map(person => person.id);
  const participantItems = await db.from('booking_participant_items')
    .select('participant_id,service_id,service_title,quantity,unit_duration_minutes,unit_price_amount')
    .in('participant_id', ids).order('created_at', { ascending: true });
  if (participantItems.error) throw new Error('PENDING_BOOKING_ITEMS_UNAVAILABLE');
  const allItems = participantItems.data || [];
  return people.map(person =>
    formatParticipant(person, allItems.filter(item => item.participant_id === person.id), storeMinutes)
  ).join('\n\n');
}
