const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../..');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(load, claim = async (config, token, eventTicketId) => ({ ticket: { claimId: 'EC-' + eventTicketId }, alreadyClaimed: false })) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8'), { url: 'https://example.test/MemberWebsocket-dev/booking/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.BookingSystem = { bookingBenefits: load, claimEventTicket: claim };
  w.confirm = () => true;
  w.eval(fs.readFileSync(path.join(root, 'ui-components.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'booking/booking-benefits.js'), 'utf8'));
  const el = id => w.document.getElementById(id);
  return { w, el, close: () => w.close(), start: () => w.BookingBenefits.start({}, 'fixture') };
}
const items = [
  { kind: 'points', id: 'reward', selectionId: 'PT-001', selectable: true, title: '集點券', cardId: 'CARD', cardTitle: '集點卡', cardStyleKey: 'lagoon', pointCost: 5, pointBalance: 10, statusLabel: '可使用', conditionLabel: '本卡目前 10 點 · 此票券需 5 點' },
  { kind: 'event', id: 'EVENT', selectionId: '', selectable: true, claimRequired: true, title: '<img src=x onerror=alert(1)>', statusLabel: '可勾選並領取', conditionLabel: '每日最多使用 2 張 · 服務限制：目前未設定' },
  { kind: 'calendar', id: 'CAL', selectionId: '', selectable: false, title: '會員活動', statusLabel: '活動進行中', conditionLabel: '會員條件：目前會員階級適用 · 活動資訊僅供預約參考' },
];

test('0/1/N benefit cards render safely inside booking form and expose only eligible selectors', async () => {
  for (const count of [0, 1, 3]) {
    let calls = 0;
    const h = fixture(async () => { calls++; return { eventTicketMaxPerDay: 2, items: items.slice(0, count) }; });
    try {
      h.start(); await tick(10);
      assert.equal(h.el('bookingBenefitsList').querySelectorAll('.booking-benefit').length, count);
      assert.equal(h.el('bookingBenefits').dataset.state, count ? 'ready' : 'empty');
      assert.equal(h.el('bookingBenefitsList').getAttribute('aria-busy'), 'false');
      assert.equal(h.el('bookingBenefits').closest('form')?.id, 'bookingForm');
      const note = h.el('memberNote');
      assert.ok(h.el('bookingBenefits').compareDocumentPosition(note) & h.w.Node.DOCUMENT_POSITION_FOLLOWING);
      assert.equal(h.el('bookingBenefitsList').querySelector('img'), null);
      const links = h.el('bookingBenefitsList').querySelectorAll('a');
      assert.ok([...links].every(link => link.textContent === '查看詳情' && new URL(link.href).origin === 'https://example.test'));
      if (count === 3) {
        const groupKinds = [...h.el('bookingBenefitsList').querySelectorAll('.booking-benefit-group')]
          .map(group => group.dataset.benefitKind);
        assert.deepEqual(groupKinds, ['calendar', 'points', 'event']);
        assert.equal(
          h.el('bookingBenefitsList').querySelector('.booking-benefit-group[data-benefit-kind="points"] a'),
          null,
          'point tickets stay actionable in booking without a detail link'
        );
        assert.equal(
          h.el('bookingBenefitsList').querySelector('.booking-benefit-group[data-benefit-kind="event"] a'),
          null,
          'event tickets stay actionable in booking without a detail link'
        );
        const pointCard = h.el('bookingBenefitsList').querySelector('.booking-benefit-group[data-benefit-kind="points"] .booking-benefit');
        const eventCard = h.el('bookingBenefitsList').querySelector('.booking-benefit-group[data-benefit-kind="event"] .booking-benefit');
        assert.equal(pointCard.dataset.cardStyle, 'lagoon', 'point ticket inherits its source point-card visual preset');
        assert.equal(eventCard.hasAttribute('data-card-style'), false, 'event tickets do not receive a point-card visual preset');
        assert.ok(
          h.el('bookingBenefitsList').querySelector('.booking-benefit-group[data-benefit-kind="calendar"] a'),
          'display-only activities may keep their calendar detail link'
        );
        assert.match(h.el('bookingBenefitsList').textContent, /活動資訊僅供預約參考/);
        assert.equal(h.el('bookingBenefitsList').querySelector('.booking-benefit-group[data-benefit-kind="calendar"] input[type="checkbox"]'), null);
        const checkboxes = h.el('bookingBenefitsList').querySelectorAll('input[type="checkbox"]');
        assert.equal(checkboxes.length, 2, 'activities are display-only; point and event tickets get checkboxes');
        const pointCheckbox = h.el('bookingBenefitsList').querySelector(
          'input[data-booking-benefit-kind="points"][data-booking-benefit-id="PT-001"]'
        );
        assert.ok(pointCheckbox);
        const eventCheckbox = h.el('bookingBenefitsList').querySelector(
          'input[data-booking-benefit-kind="event"][data-booking-benefit-id="EVENT"][data-booking-benefit-claim-required="true"]'
        );
        assert.ok(eventCheckbox, 'unclaimed event ticket exposes a claim-on-check selector');
        pointCheckbox.click();
        assert.equal(JSON.stringify(h.w.BookingBenefits.selectionPayload()), JSON.stringify([{ kind: 'points', id: 'PT-001' }]));
      }
      assert.equal(calls, 1, 'rendering and selection do not claim/redeem or start extra requests');
    } finally { h.close(); }
  }
});

test('regular booking can select GPS-restricted point and event tickets without accessing geolocation', async () => {
  const restricted = [
    { ...items[0], selectionId: 'PT-GPS', requiresLocation: true, statusLabel: '可預約選用', conditionLabel: '現場單獨使用需 GPS 定位' },
    { ...items[1], id: 'EVENT-GPS', requiresLocation: true, conditionLabel: '現場單獨使用需 GPS 定位' },
  ];
  let claimed = 0;
  const h = fixture(
    async () => ({ pointTicketMaxPerRedemption: 2, eventTicketMaxPerDay: 2, items: restricted }),
    async () => { claimed++; return { ticket: { claimId: 'EC-GPS' }, alreadyClaimed: false }; },
  );
  let gpsCalls = 0;
  try {
    Object.defineProperty(h.w.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: () => { gpsCalls++; throw Error('booking must not ask for GPS'); } },
    });
    h.start();
    await tick(10);
    const point = h.el('bookingBenefitsList').querySelector('[data-booking-benefit-id="PT-GPS"]');
    const event = h.el('bookingBenefitsList').querySelector('[data-booking-benefit-id="EVENT-GPS"]');
    assert.ok(point && event);
    assert.equal(point.disabled, false);
    assert.equal(event.disabled, false);
    assert.match(h.el('bookingBenefitsList').textContent, /現場單獨使用需 GPS 定位/);
    point.click();
    h.el('bookingBenefitsList').querySelector('[data-booking-benefit-id="EVENT-GPS"]').click();
    await tick(15);
    assert.equal(claimed, 1, 'event claim is allowed without a GPS proof');
    assert.equal(gpsCalls, 0, 'ordinary booking must not request user location');
    assert.deepEqual(JSON.parse(JSON.stringify(h.w.BookingBenefits.selectionPayload())), [
      { kind: 'points', id: 'PT-GPS' },
      { kind: 'event', id: 'EC-GPS' },
    ]);
    h.w.BookingBenefits.syncNow();
    await tick(15);
    assert.equal(gpsCalls, 0);
  } finally { h.close(); }
});

test('point ticket selection cannot exceed the current balance on the same card', async () => {
  const pointItems = [
    { kind: 'points', id: 'reward-a', selectionId: 'PT-A', selectable: true, title: '票券 A', cardId: 'CARD', cardTitle: '集點卡', pointCost: 6, pointBalance: 10, statusLabel: '可使用', conditionLabel: '本卡目前 10 點 · 此票券需 6 點' },
    { kind: 'points', id: 'reward-b', selectionId: 'PT-B', selectable: true, title: '票券 B', cardId: 'CARD', cardTitle: '集點卡', pointCost: 5, pointBalance: 10, statusLabel: '可使用', conditionLabel: '本卡目前 10 點 · 此票券需 5 點' },
  ];
  const h = fixture(async () => ({ pointTicketMaxPerRedemption: 2, items: pointItems }));
  try {
    h.start(); await tick(10);
    const first = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-A"]');
    const second = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-B"]');
    assert.ok(first && second);
    first.click();
    assert.equal(JSON.stringify(h.w.BookingBenefits.selectionPayload()), JSON.stringify([{ kind: 'points', id: 'PT-A' }]));
    const refreshedSecond = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-B"]');
    assert.equal(refreshedSecond.disabled, true, '6 + 5 points must not exceed a 10 point balance');
    assert.match(refreshedSecond.parentElement.textContent, /點數不足/);

    const selectedFirst = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-A"]');
    assert.ok(selectedFirst);
    selectedFirst.click();
    const enabledAgain = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-B"]');
    assert.equal(enabledAgain.disabled, false, 'removing a ticket restores the available point budget');
  } finally { h.close(); }
});

test('slow/error recommendation API leaves booking interactions usable and supports retry', async () => {
  let reject;
  const h = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
  try {
    let booked = false;
    h.el('submitBookingButton').disabled = false;
    h.el('bookingForm').addEventListener('submit', event => { event.preventDefault(); booked = true; });
    h.start();
    assert.equal(h.el('bookingBenefits').dataset.state, 'loading');
    h.el('submitBookingButton').click();
    assert.equal(booked, true, 'booking proceeds while recommendation request hangs');
    reject(new Error('weak network')); await tick(10);
    assert.equal(h.el('bookingBenefits').dataset.state, 'error');
    assert.match(h.el('bookingBenefitsStatus').textContent, /仍可正常預約/);
    h.w.BookingSystem.bookingBenefits = async () => ({ items: [] });
    h.el('bookingBenefitsRetry').click(); await tick(10);
    assert.equal(h.el('bookingBenefits').dataset.state, 'empty');
  } finally { h.close(); }
});

test('point realtime sync bypasses debounce and reconciles stale selections', async () => {
  let calls = 0;
  const snapshots = [
    {
      pointTicketMaxPerRedemption: 2,
      items: [
        { kind: 'points', id: 'reward', selectionId: 'PT-001', selectable: true, title: '集點券', cardId: 'CARD', cardTitle: '集點卡', pointCost: 5, pointBalance: 10, statusLabel: '可使用', conditionLabel: '本卡目前 10 點 · 此票券需 5 點' },
      ],
    },
    {
      pointTicketMaxPerRedemption: 2,
      items: [
        { kind: 'points', id: 'reward', selectionId: 'PT-001', selectable: false, title: '集點券', cardId: 'CARD', cardTitle: '集點卡', pointCost: 5, pointBalance: 4, statusLabel: '點數不足', conditionLabel: '本卡目前 4 點 · 此票券需 5 點', disabledReason: '點數不足' },
      ],
    },
  ];
  const h = fixture(async () => snapshots[Math.min(calls++, snapshots.length - 1)]);
  try {
    h.start(); await tick(10);
    const point = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-001"]');
    assert.ok(point);
    point.click();
    assert.equal(JSON.stringify(h.w.BookingBenefits.selectionPayload()), JSON.stringify([{ kind: 'points', id: 'PT-001' }]));

    h.w.BookingBenefits.invalidate();
    assert.equal(calls, 1, 'ordinary invalidation remains debounced');
    h.w.BookingBenefits.syncNow();
    await tick(10);
    assert.equal(calls, 2, 'point realtime sync refetches immediately');
    assert.deepEqual(JSON.parse(JSON.stringify(h.w.BookingBenefits.selectionPayload())), [], 'stale selected ticket is removed when the refreshed balance cannot fund it');
    const refreshed = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-001"]');
    assert.ok(refreshed);
    assert.equal(refreshed.disabled, true);
    assert.match(h.el('bookingBenefitsList').textContent, /點數不足/);
  } finally { h.close(); }
});

test('realtime invalidation drops used tickets, coalesces storms and ignores stale responses', async () => {
  let resolveFirst, calls = 0;
  const h = fixture(() => {
    calls++;
    return calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ items: [] });
  });
  try {
    h.start();
    for (let i = 0; i < 20; i++) h.w.BookingBenefits.invalidate();
    resolveFirst({ items }); await tick(10);
    assert.equal(h.el('bookingBenefitsList').querySelectorAll('.booking-benefit').length, 0, 'stale inventory must never render');
    await tick(500);
    assert.equal(calls, 2);
    assert.equal(h.el('bookingBenefits').dataset.state, 'empty');
    h.w.BookingSystem.bookingBenefits = async () => ({ items });
    h.w.BookingBenefits.invalidate(); await tick(500);
    assert.equal(h.el('bookingBenefitsList').querySelectorAll('.booking-benefit').length, 3);
    h.w.BookingSystem.bookingBenefits = async () => ({ items: [] });
    h.w.BookingBenefits.invalidate();
    assert.equal(
      h.el('bookingBenefitsList').querySelectorAll('.booking-benefit').length,
      3,
      'current tickets stay visible while a background refresh is pending'
    );
    assert.equal(h.el('bookingBenefitsList').getAttribute('aria-busy'), 'true');
    await tick(500);
    assert.equal(h.el('bookingBenefitsList').querySelectorAll('.booking-benefit').length, 0);
    assert.equal(h.el('bookingBenefits').dataset.state, 'empty');
  } finally { h.close(); }
});


test('service-restricted tickets require a matching booked service and are removed when that service disappears', async () => {
  const restrictedItems = [
    {
      kind: 'points',
      id: 'body-reward',
      selectionId: 'PT-BODY',
      selectable: true,
      title: '身體集點卡優惠券',
      cardId: 'BODY-CARD',
      cardTitle: '身體集點卡',
      pointCost: 5,
      pointBalance: 10,
      requiredServiceIds: ['service-body-60'],
      requiredServiceTitles: ['身體調理 60 分鐘'],
      requiredServiceMatchMode: 'any',
      requiredServiceRequirementLabel: '需預約「身體調理 60 分鐘」項目',
      statusLabel: '可使用',
      conditionLabel: '預約項目限制：需預約「身體調理 60 分鐘」項目 · 本卡可用 10 點 · 此票券需 5 點',
    },
  ];
  const h = fixture(async () => ({ pointTicketMaxPerRedemption: 2, items: restrictedItems }));
  try {
    h.start();
    await tick(10);

    let checkbox = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-BODY"]');
    assert.ok(checkbox);
    assert.equal(checkbox.disabled, true, 'restricted tickets explain their requirements and cannot be selected');
    assert.match(checkbox.parentElement.textContent, /需先預約：身體調理 60 分鐘/);

    checkbox.click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.w.BookingBenefits.selectionPayload())), []);
    checkbox.checked = true;
    checkbox.dispatchEvent(new h.w.Event('change'));
    assert.deepEqual(JSON.parse(JSON.stringify(h.w.BookingBenefits.selectionPayload())), []);
    assert.match(h.el('bookingBenefitsStatus').textContent, /需預約「身體調理 60 分鐘」項目才能使用這張票券/);

    h.w.BookingBenefits.setServiceContext(['service-body-60']);
    checkbox = h.el('bookingBenefitsList').querySelector('input[data-booking-benefit-id="PT-BODY"]');
    checkbox.click();
    assert.deepEqual(
      JSON.parse(JSON.stringify(h.w.BookingBenefits.selectionPayload())),
      [{ kind: 'points', id: 'PT-BODY' }]
    );

    h.w.BookingBenefits.setServiceContext(['service-foot-60']);
    assert.deepEqual(JSON.parse(JSON.stringify(h.w.BookingBenefits.selectionPayload())), []);
    assert.match(h.el('bookingBenefitsStatus').textContent, /已自動取消那些票券/);
  } finally {
    h.close();
  }
});
