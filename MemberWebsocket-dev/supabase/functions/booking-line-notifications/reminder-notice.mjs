// Group multi-line reminder prose into one LINE Flex section instead of a narrow label/value row.
const MAX_NOTICE_TEXT = 500;

export function groupReminderNoticeFields(fields) {
  const result = [];
  let reminder = null;
  for (const field of fields) {
    if (field.label !== '提醒事項') {
      result.push(field);
      continue;
    }
    const value = String(field.value ?? '').replace(/\r\n?/g, '\n').trim();
    if (!value) continue;
    if (reminder) {
      reminder.value = Array.from(reminder.value + '\n' + value).slice(0, MAX_NOTICE_TEXT).join('');
    } else {
      reminder = { label: '提醒事項', value: Array.from(value).slice(0, MAX_NOTICE_TEXT).join('') };
      result.push(reminder);
    }
  }
  return result;
}

export function reminderNoticeCard(fields) {
  const value = fields.find(field => field.label === '提醒事項')?.value;
  if (!value) return null;
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '14px',
    backgroundColor: '#F6F8F7',
    cornerRadius: '12px',
    contents: [
      { type: 'text', text: '預約注意事項', size: 'sm', color: '#728079', weight: 'bold' },
      { type: 'text', text: value, size: 'sm', color: '#17352E', wrap: true },
    ],
  };
}
