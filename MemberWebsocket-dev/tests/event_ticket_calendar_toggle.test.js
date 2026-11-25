const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../admin/grant-automation.js'), 'utf8');

function fixture({ checked = true, existing = [], failAction = '' } = {}) {
  const calls = [];
  const checkbox = { checked, disabled: false, dataset: { syncUnknown: '0' } };
  const status = { textContent: '' };
  const ticket = {
    eventTicketId: 'EVT-CASE-1', title: 'QA 活動票券', itemType: 'event',
    description: '活動票券說明', startsOn: '2026-12-01', endsOn: '2026-12-31',
    status: 'draft', accent: '#123456', allowedTierKeys: ['gold'],
    visibilityPolicy: 'higher_preview'
  };
  const originals = {
    'admin.event-tickets.save': () => ({ eventTicket: { ...ticket } }),
    'admin.calendar-items.list': () => ({ calendarItems: existing }),
    'admin.calendar-items.save': (p) => ({ calendarItem: { ...p.calendarItem, calendarItemId: 'CAL-1' } }),
    'admin.calendar-items.delete': () => ({ deleted: true }),
    'admin.bootstrap': () => ({ calendarItems: existing, features: { calendar: true } })
  };
  const window = {
    location: { href: 'https://qa.example/admin/' },
    addEventListener() {},
    setTimeout, clearTimeout,
    MemberSystem: {
      async request(config, clientType, idToken, action, payload) {
        calls.push({ config, clientType, idToken, action, payload });
        if (action === failAction) throw Object.assign(new Error('synthetic failure'), { code: 'SYNTHETIC' });
        assert.ok(originals[action], 'unexpected API action: ' + action);
        return originals[action](payload);
      }
    }
  };
  const document = {
    getElementById(id) {
      return { eventTicketAddToCalendar: checkbox, eventTicketCalendarStatus: status }[id] || null;
    }
  };
  vm.runInNewContext(script, { window, document, URL, setTimeout, clearTimeout, console }, {
    filename: 'grant-automation.js'
  });
  const config = { grantedFeatures: { calendar: true } };
  return { window, calls, checkbox, status, config, ticket };
}

test('AC-001: opting in writes one linked calendar item through the canonical admin API', async () => {
  const h = fixture();
  const result = await h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token',
    'admin.event-tickets.save', { eventTicket: h.ticket });
  assert.equal(result.eventTicket.eventTicketId, 'EVT-CASE-1');
  assert.deepEqual(h.calls.map((x) => x.action), [
    'admin.event-tickets.save', 'admin.calendar-items.list', 'admin.calendar-items.save'
  ]);
  const item = h.calls.at(-1).payload.calendarItem;
  assert.equal(item.startsOn, '2026-12-01');
  assert.equal(item.visibilityPolicy, 'higher_preview');
  assert.equal(item.linkLabel, '查看活動票券');
  const link = new URL(item.linkUrl);
  assert.equal(link.searchParams.get('eventTicketId'), 'EVT-CASE-1');
  assert.equal(link.searchParams.get('source'), 'event-ticket-calendar');
  assert.ok(!('bonusPointsEnabled' in item), 'retired bonus flags must not be sent');
  assert.match(h.status.textContent, /已加入日曆/);
});

test('AC-002: opting out removes only the matching ticket-linked calendar item', async () => {
  const calendarItems = [
    { calendarItemId: 'CAL-1', updatedAt: 'version-1', itemType: 'event',
      linkUrl: 'https://qa.example/event/?source=event-ticket-calendar&eventTicketId=EVT-CASE-1' },
    { calendarItemId: 'CAL-OTHER', updatedAt: 'version-1', itemType: 'event',
      linkUrl: 'https://qa.example/event/?source=event-ticket-calendar&eventTicketId=EVT-OTHER' }
  ];
  const h = fixture({ checked: false, existing: calendarItems });
  await h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token',
    'admin.event-tickets.save', { eventTicket: h.ticket });
  assert.deepEqual(h.calls.map((x) => x.action), [
    'admin.event-tickets.save', 'admin.calendar-items.list', 'admin.calendar-items.delete'
  ]);
  assert.equal(h.calls.at(-1).payload.calendarItemId, 'CAL-1');
  assert.equal(h.calls.at(-1).payload.expectedUpdatedAt, 'version-1');
  assert.match(h.status.textContent, /從日曆移除/);
});

test('AC-003: failure after ticket save is explicit, never silently treated as full success', async () => {
  const h = fixture({ failAction: 'admin.calendar-items.save' });
  await assert.rejects(
    h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token',
      'admin.event-tickets.save', { eventTicket: h.ticket }),
    (error) => error.code === 'CALENDAR_SYNC_PARTIAL' && /票券已儲存/.test(error.message)
  );
  assert.match(h.status.textContent, /日曆同步失敗/);
  assert.deepEqual(h.calls.map((x) => x.action), [
    'admin.event-tickets.save', 'admin.calendar-items.list', 'admin.calendar-items.save'
  ]);
});

test('AC-004: a failed calendar read never deletes an existing calendar item', async () => {
  const h = fixture({ checked: false, failAction: 'admin.calendar-items.list' });
  await assert.rejects(
    h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token',
      'admin.event-tickets.save', { eventTicket: h.ticket }),
    (error) => error.code === 'CALENDAR_SYNC_PARTIAL'
  );
  assert.ok(!h.calls.some((x) => x.action === 'admin.calendar-items.delete'));
});

test('AC-005: bootstrap and calendar save/list use only the canonical API', async () => {
  const h = fixture();
  await h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token', 'admin.bootstrap', {});
  await h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token',
    'admin.calendar-items.save', { calendarItem: { itemType: 'event', title: '一般會員活動' } });
  await h.window.MemberSystem.request(h.config, 'admin', 'synthetic-token',
    'admin.calendar-items.list', {});
  assert.deepEqual(h.calls.map((x) => x.action), [
    'admin.bootstrap', 'admin.calendar-items.save', 'admin.calendar-items.list'
  ]);
});

test('AC-006: the editor prevents an unknown choice from being saved and allows explicit retry', () => {
  assert.match(script, /checkbox\.dataset\.syncUnknown === '1'[\s\S]*?event\.preventDefault\(\)/);
  assert.match(script, /eventTicketCalendarRetryButton[\s\S]*?syncEventTicketCalendarChoiceFromSelection\(true\)/);
  assert.match(script, /fetchCalendarItemsForEventSync[\s\S]*?originalRequest\(config, 'admin', idToken, 'admin\.calendar-items\.list'/);
});

test('AC-007: admin entry loads the updated calendar toggle script instead of a cached legacy asset', () => {
  const html = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  assert.match(html, /grant-automation\\.js\\?v=grant-automation-20261125-ticket-calendar-1/);
  assert.doesNotMatch(html, /grant-automation\\.js\\?v=grant-automation-20260910/);
});
