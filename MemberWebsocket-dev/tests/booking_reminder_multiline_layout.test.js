const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const loadNotice = () => import(pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/reminder-notice.mjs')).href);

test('AC-RML-001: multiple merchant reminder lines render in one full-width section', async () => {
  const { groupReminderNoticeFields, reminderNoticeCard } = await loadNotice();
  const paragraphs = [
    '🎀預約注意事項',
    '請準時抵達，預約時間恕不保留。',
    '若超過預約時間仍未到場，遇現場人力不足時，原預約技師可能會安排服務其他客人，恕無法保證原技師仍可提供服務。',
    '感謝您的配合！',
  ];
  const fields = paragraphs.map(value => ({ label: '提醒事項', value }));
  fields.push({ label: '預約人', value: '陳先生' });
  const grouped = groupReminderNoticeFields(fields);
  assert.equal(grouped.filter(field => field.label === '提醒事項').length, 1);
  assert.equal(grouped[0].value, paragraphs.join('\n'));
  assert.equal(grouped[1].label, '預約人');
  const card = reminderNoticeCard(grouped);
  assert.equal(card.layout, 'vertical');
  assert.equal(card.contents.length, 2);
  assert.equal(card.contents[0].text, '預約注意事項');
  assert.equal(card.contents[1].text, paragraphs.join('\n'));
  assert.equal(card.contents[1].wrap, true);
  assert.doesNotMatch(JSON.stringify(card), /68px|layout":"horizontal|提醒事項/);
});

test('AC-RML-002: 400-character notice stays intact, empty lines are ignored, and no notice produces no card', async () => {
  const { groupReminderNoticeFields, reminderNoticeCard } = await loadNotice();
  const text = '請注意：' + '長'.repeat(395) + '！';
  assert.equal(Array.from(text).length, 400);
  const grouped = groupReminderNoticeFields([
    { label: '提醒事項', value: text.slice(0, 200) },
    { label: '提醒事項', value: '   ' },
    { label: '提醒事項', value: text.slice(200) },
  ]);
  assert.equal(grouped[0].value, text.slice(0, 200) + '\n' + text.slice(200));
  assert.equal(reminderNoticeCard(grouped).contents[1].text, grouped[0].value);
  assert.equal(reminderNoticeCard([{ label: '日期', value: '2026/11/02' }]), null);
});

test('AC-RML-003: LINE dispatcher groups legacy reminder fields but preserves confirmation and booking details', async () => {
  const src = fs.readFileSync(path.join(root, 'supabase/functions/booking-line-notifications/delivery.ts'), 'utf8');
  assert.match(src, /import \{ groupReminderNoticeFields, reminderNoticeCard \} from "\.\/reminder-notice\.mjs"/);
  assert.match(src, /title === '預約提醒' \? groupReminderNoticeFields\(fields\) : fields/);
  assert.match(src, /const notice = memberReminder \? reminderNoticeCard\(parsed\.fields\) : null/);
  assert.match(src, /detailsCard\(memberReminder \? parsed\.fields\.filter\(field => field\.label !== '提醒事項'\) : parsed\.fields\)/);
  assert.match(src, /if \(memberReminder && notice\) bodyContents\.push\(notice\)/);
  assert.match(src, /if \(memberReminder && details\) bodyContents\.push\(details\)/);
  assert.match(src, /memberConfirmation \|\| memberReminder/);
});

test('AC-RML-004: original reminder formatter still supplies every entered line without truncating long text', async () => {
  const { formatBookingReminderMessage } = await import(pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/reminder-message.mjs')).href);
  const lines = ['🎀預約注意事項', '請準時抵達。', '若超過預約時間仍未到場，原預約技師可能無法服務。', '感謝您的配合！'];
  const message = formatBookingReminderMessage({
    booking: {
      booking_date: '2026-11-05', start_at: '2026-11-05T11:00:00',
      end_at: '2026-11-05T12:00:00', party_size: 1, contact_surname: '陳',
    },
    member: {}, reminderText: lines.join('\n'),
  });
  for (const line of lines) assert.ok(message.includes('提醒事項：' + line), line);
  assert.match(message, /第一位預約/);
  assert.match(message, /預約人：陳/);
});
