// Booking reminder message renderer: pure data-to-text conversion used by LINE dispatch and Node tests.
export const DEFAULT_BOOKING_REMINDER_TEXT = '請準時到場；如需調整請至預約頁操作。';
const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
const ORDINALS = ['一','二','三','四','五','六','七','八','九','十'];
const money = n => Math.max(0, Number(n) || 0).toLocaleString('en-US');
const tidy = value => String(value ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
const qty = item => Math.max(1, Number(item.quantity) || 1);
const datePart = value => String(value || '').slice(0, 10).replaceAll('-', '/');
const timePart = value => String(value || '').slice(11, 16);
const techName = (id, technicians) => tidy(technicians.find(t => t.id === id)?.name) || '現場安排';

export function formatBookingReminderMessage({booking, member, participants = [], bookingItems = [], participantItems = [], technicians = [], reminderText = DEFAULT_BOOKING_REMINDER_TEXT}) {
  if (!booking?.start_at || !booking?.end_at) throw new Error('REMINDER_BOOKING_SCHEDULE_MISSING');
  const name = tidy(booking.contact_surname) || tidy(member?.surname) || '會員';
  const salutation = tidy(booking.contact_salutation) || tidy(member?.salutation);
  const recipient = name + (salutation === 'mr' ? '先生' : salutation === 'ms' ? '小姐' : '');
  const phone = tidy(booking.contact_phone) || tidy(member?.phone) || '未提供';
  const text = String(reminderText ?? DEFAULT_BOOKING_REMINDER_TEXT).replace(/\r\n?/g, '\n').trim();
  const lines = ['【預約提醒】'];
  for (const line of (text || DEFAULT_BOOKING_REMINDER_TEXT).split('\n')) {
    if (tidy(line)) lines.push('提醒事項：' + tidy(line));
  }
  lines.push(
    '日期：' + datePart(booking.start_at),
    '預約人：' + recipient,
    '營業日：' + datePart(booking.booking_date),
    '時段：' + datePart(booking.start_at) + ' ' + timePart(booking.start_at) + '–' + datePart(booking.end_at) + ' ' + timePart(booking.end_at) + '（台北時間）',
    '電話：' + phone,
    '預約人數：' + Math.max(1, Number(booking.party_size) || 1) + ' 位'
  );
  if (tidy(booking.member_note)) lines.push('會員備註：' + tidy(booking.member_note).slice(0, 180));
  if (tidy(booking.admin_note)) lines.push('管理端說明：' + tidy(booking.admin_note).slice(0, 180));
  lines.push('');
  const storeMinutes = bookingItems.filter(i => i.service_id === STORE_SERVICE_ID).reduce((sum, i) => sum + Number(i.unit_duration_minutes || 0) * qty(i), 0);
  const ordered = [...participants].sort((a, b) => Number(a.position) - Number(b.position));
  const group = ordered.length ? ordered : [{id: null, position: 1, technician_id: booking.technician_id}];
  for (const person of group) {
    const order = Number(person.position) || 1;
    const own = person.id ? participantItems.filter(i => i.participant_id === person.id) : bookingItems.filter(i => i.service_id !== STORE_SERVICE_ID);
    const list = own.map(i => tidy(i.service_title) + (qty(i) > 1 ? ' × ' + qty(i) : '')).filter(Boolean).join('、') || '請至預約頁查看';
    const duration = own.reduce((sum, i) => sum + Number(i.unit_duration_minutes || 0) * qty(i), 0) + storeMinutes;
    const amount = own.reduce((sum, i) => sum + Number(i.unit_price_amount || 0) * qty(i), 0);
    lines.push(
      (order <= 10 ? '第' + ORDINALS[order - 1] : '第 ' + order + ' ') + '位預約',
      '預約項目：' + list,
      '個別時間：' + duration + ' 分鐘' + (storeMinutes ? '（含店內服務 ' + storeMinutes + ' 分鐘）' : ''),
      '個別金額：NT$' + money(amount),
      '預約技師：' + techName(person.technician_id, technicians),
      ''
    );
  }
  // LINE supports at most 2200 message characters; the flex parser also bounds component text.
  return Array.from(lines.join('\n').trim()).slice(0, 2200).join('');
}
