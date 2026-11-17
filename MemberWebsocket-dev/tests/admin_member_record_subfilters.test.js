const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../admin/app.js'), 'utf8');
function harness(records = {}, filter = 'all', subfilter = 'all') {
  const state = { memberRecords: { data: { records }, filter, subfilter } };
  const constants = source.slice(source.indexOf('  const MEMBER_RECORD_FILTERS'), source.indexOf('  async function openMemberRecordsModal'));
  const list = source.slice(source.indexOf('  function memberRecordsForFilter()'), source.indexOf('  function createMemberRecordItem('));
  const display = source.slice(source.indexOf('  function memberRecordTitle('), source.indexOf('  function formatMemberRecordDateTime('));
  const api = vm.runInNewContext(constants + list + display + `\n({
    classify: typeof memberRecordSubcategory === 'function' ? memberRecordSubcategory : null,
    options: typeof memberRecordSubfilterOptions === 'function' ? memberRecordSubfilterOptions : null,
    list: memberRecordsForFilter, title: memberRecordTitle, summary: memberRecordSummary, details: memberRecordDetails
  })`, { state });
  return { ...api, state };
}

// A wrong enum mapping or fallback must fail these literal expectations.
test('AC-001: existing activity fields classify without conflating domains', () => {
  const { classify } = harness();
  assert.equal(typeof classify, 'function', 'activity subtype classifier is required');
  for (const [category, record, expected] of [
    ['presence', { event: 'online' }, 'online'], ['presence', { event: 'offline' }, 'offline'],
    ...['grant','earn','redeem','booking_reward','calendar_bonus','adjustment','transfer_in','transfer_out'].map(type => ['pointCards', {recordType:'point_entry',entryType:type}, type]),
    ['pointCards', {recordType:'point_entry',entryType:'redemption'}, 'redeem'],
    ['pointCards', {recordType:'point_entry',entryType:'grant',referenceType:'booking'}, 'booking_reward'],
    ['pointCards', {recordType:'point_entry',entryType:'grant',referenceType:'calendar_bonus'}, 'calendar_bonus'],
    ['pointCards', {recordType:'point_ticket',entryType:'grant'}, 'point_ticket'],
    ...['coupon','lottery','referral','membership_join'].map(type => ['eventTickets', {ticketType:type}, type]),
    ['calendar', {itemType:'event'}, 'event'], ['calendar', {itemType:'holiday'}, 'holiday'],
    ...['pending','confirmed','completed','cancelled','rejected','no_show'].map(status => ['bookings', {status}, status]),
    ['bookings', {status:'cancel_requested'}, 'cancellation_requested'],
    ['bookings', {status:'confirmed',cancellationRequestedAt:'2026-11-17T00:00:00Z'}, 'cancellation_requested'],
    ['bookings', {status:'confirmed',cancellationRequestedAt:'2026-11-17T00:00:00Z',cancellationReviewedAt:'2026-11-17T01:00:00Z'}, 'confirmed'],
    ['bookings', {status:'completed',cancellationRequestedAt:'2026-11-17T00:00:00Z'}, 'completed'],
    ['bookings', {status:'cancelled',cancellationRequestedAt:'2026-11-17T00:00:00Z'}, 'cancelled'],
  ]) assert.equal(classify(record, category), expected, JSON.stringify([category,record]));
});

test('AC-002: missing or unknown values are preserved as other, never invented events', () => {
  const { classify } = harness();
  assert.equal(typeof classify, 'function');
  for (const category of ['presence','pointCards','eventTickets','calendar','bookings']) {
    for (const record of [{}, null, {event:'future',recordType:'future',ticketType:'future',itemType:'future',status:'future'}]) {
      assert.equal(classify(record, category), 'other');
    }
  }
});

test('AC-001/002: subtype counts partition the selected category and retain zero options', () => {
  const { options } = harness();
  assert.equal(typeof options, 'function');
  const rows = [{event:'online'}, {event:'offline'}, {event:'online'}, {event:'future'}];
  assert.deepEqual(JSON.parse(JSON.stringify(options('presence', rows))), [
    ['all','全部細項',4], ['online','上線',2], ['offline','下線',1], ['other','其他',1],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(options('presence', []))), [
    ['all','全部細項',0], ['online','上線',0], ['offline','下線',0], ['other','其他',0],
  ]);
});

test('AC-004: subtype filtering keeps only matches, orders latest first and leaves source intact', () => {
  const rows = [
    {recordId:'older',event:'online',occurredAt:'2026-11-16T12:00:00Z'},
    {recordId:'offline',event:'offline',occurredAt:'2026-11-17T12:00:00Z'},
    {recordId:'newer',event:'online',occurredAt:'2026-11-17T11:00:00Z'},
  ];
  const original = JSON.stringify(rows);
  const { list } = harness({presence:rows}, 'presence', 'online');
  assert.deepEqual(Array.from(list(), r => r.recordId), ['newer','older']);
  assert.equal(JSON.stringify(rows), original);
});

test('AC-004: every category keeps invalid dates last and equal timestamps stable', () => {
  for (const category of ['presence','pointCards','eventTickets','calendar','bookings']) {
    const { list } = harness({[category]:[
      {recordId:'invalid',occurredAt:'bad'},
      {recordId:'old',occurredAt:'1969-12-01T00:00:00Z'},
      {recordId:'new-a',occurredAt:'2026-11-17T00:00:00Z'},
      {recordId:'new-b',occurredAt:'2026-11-17T00:00:00Z'},
      {recordId:'invalid-b'},
    ]}, category);
    assert.deepEqual(Array.from(list(), r => r.recordId), ['new-a','new-b','old','invalid','invalid-b']);
  }
});

test('AC-002: unknown connection events never claim online in title, summary or reason', () => {
  const ui = harness();
  const row = {event:'future',reason:'future',surface:'member'};
  assert.equal(ui.title(row,'presence'), '會員連線紀錄');
  assert.equal(ui.summary(row,'presence'), '未識別的連線事件 · 會員卡');
  assert.deepEqual(Array.from(ui.details(row,'presence')), ['來源：會員卡','原因：未識別的連線事件']);
  assert.equal(ui.title({event:'ONLINE'},'presence'), '會員上線');
});

test('AC-001: point details use actual reward source rather than calling every grant administrator-issued', () => {
  const { details } = harness();
  assert.deepEqual(Array.from(details({recordType:'point_entry',entryType:'grant',referenceType:'booking'},'pointCards')), ['類型：預約回饋','來源：預約']);
  assert.deepEqual(Array.from(details({recordType:'point_entry',entryType:'grant',referenceType:'calendar_bonus'},'pointCards')), ['類型：日曆回饋','來源：日曆活動回饋']);
});

test('AC-001/002: all keeps unknown records and excludes unexposed test automation', () => {
  const { list } = harness({presence:[{recordId:'unknown',event:'future'}], pointCards:[{recordId:'points'}], testAutomation:[{recordId:'private-test'}]});
  assert.deepEqual(Array.from(list(), r => r.recordId), ['unknown','points']);
});
