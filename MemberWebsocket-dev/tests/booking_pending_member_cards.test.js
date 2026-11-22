const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root,
  'supabase/functions/booking-line-notifications/member-pending-cards.mjs')).href;
const delivery = fs.readFileSync(path.join(root,
  'supabase/functions/booking-line-notifications/delivery.ts'), 'utf8');

test('AC-BLK-001: member pending Flex shows one complete booking-data card for two people', async () => {
  const { buildMemberPendingCards } = await import(url);
  const parsed = {
    fields: [
      { label: '狀態', value: '等待管理員確認預約' },
      { label: '日期', value: '2026/11/22' },
      { label: '時段', value: '2026/11/22 14:00–2026/11/22 15:10' },
      { label: '預約人', value: '陳先生' },
      { label: '預約人數', value: '2 位' },
      { label: '預約編號', value: 'private-id' },
      { label: '提醒事項', value: '請等待管理員確認。' },
    ],
    participants: [
      { label: '第一位預約', items: ['按摩 × 2'], duration: '70 分鐘',
        amount: 'NT$1,600', technician: '10技師', note: '希望靠窗' },
      { label: '第二位預約', items: ['腳底45'], duration: '55 分鐘',
        amount: 'NT$900', technician: '現場安排', note: '' },
    ],
    services: [],
  };
  const cards = buildMemberPendingCards(parsed, '#397AA3');
  assert.equal(cards.length, 3);
  const booking = cards[1];
  assert.equal(booking.contents[0].text, '預約資料');
  const text = booking.contents.filter(c => c.type === 'text').map(c => c.text);
  for (const expected of ['預約日期：2026/11/22','預約時間：2026/11/22 14:00–2026/11/22 15:10',
    '預約人：陳先生','預約人數：2 位','第一位預約','預約項目：按摩 × 2',
    '個別時間：70 分鐘','個別金額：NT$1,600','預約技師：10技師',
    '個別備註：希望靠窗','第二位預約','預約項目：腳底45',
    '個別金額：NT$900']) assert.ok(text.includes(expected), expected);
  assert.equal((JSON.stringify(cards).match(/預約資料/g) || []).length, 1);
  assert.equal(cards[0].contents[0].text, '預約狀態：等待管理員確認預約');
  assert.equal(cards[2].contents[0].text, '預約申請說明');
  assert.doesNotMatch(JSON.stringify(booking), /提醒事項|等待管理員確認|private-id/);
});

test('AC-BLK-002: multiline admin prose remains a single separate full-width notice', async () => {
  const { buildMemberPendingCards } = await import(url);
  const cards = buildMemberPendingCards({
    fields: [
      { label: '日期', value: '2026/11/22' },
      { label: '提醒事項', value: '歡迎預約' },
      { label: '提醒事項', value: '請等待管理員確認' },
      { label: '提醒事項', value: '稍後會通知結果' },
    ], participants: [{ label: '第一位預約', items: ['按摩'] }],
  }, '#397AA3');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].contents[0].text, '預約資料');
  const notice = cards[1];
  assert.equal(notice.contents[0].text, '預約申請說明');
  assert.equal(notice.contents[1].text, '歡迎預約\n請等待管理員確認\n稍後會通知結果');
  assert.equal(notice.contents[1].wrap, true);
  assert.equal((JSON.stringify(notice).match(/預約申請說明/g) || []).length, 1);
  assert.doesNotMatch(JSON.stringify(cards[0]), /歡迎預約|稍後會通知結果/);
});

test('AC-BLK-003: legacy single-person booking still shows a booking-data section', async () => {
  const { buildMemberPendingCards } = await import(url);
  const cards = buildMemberPendingCards({ fields: [
    { label: '日期', value: '2026/11/22' }, { label: '預約人', value: '林小姐' },
  ], participants: [], services: ['肩頸30'] }, '#397AA3');
  assert.equal(cards.length, 1);
  const lines = cards[0].contents.filter(c => c.type === 'text').map(c => c.text);
  assert.ok(lines.includes('預約資料'));
  assert.ok(lines.includes('第一位預約'));
  assert.ok(lines.includes('預約項目：肩頸30'));
  assert.ok(lines.includes('預約人：林小姐'));
});

test('AC-BLK-004: only member pending messages use new card; no LINE identity leakage', () => {
  assert.match(delivery, /import \{ buildMemberPendingCards \} from "\.\/member-pending-cards\.mjs"/);
  assert.match(delivery, /const memberPending = job\.channel === 'member' && parsed\.title === '預約申請'/);
  assert.match(delivery, /if \(memberPending\) \{[\s\S]*?buildMemberPendingCards\(parsed, style\.color\)/);
  assert.match(delivery, /else if \(job\.channel === 'frontdesk'\)/);
  assert.match(delivery, /if \(memberConfirmation \|\| memberReminder\)/);
  assert.match(delivery, /(?:預約編號\|原預約編號\|新增預約編號\|訂單編號)/);
});
