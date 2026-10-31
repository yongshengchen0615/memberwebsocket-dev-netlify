const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '../..');

if (!process.argv.includes('--fixture')) {
  for (const mode of ['success', 'group-error', 'unauthorized', 'membership-required']) {
    test(`booking entrypoint remains usable (${mode})`, () => {
      const result = spawnSync(process.execPath, [__filename, '--fixture', mode], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.error, undefined, 'Booking observers must not starve the event loop');
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
} else {
  fixture(process.argv.at(-1)).catch(error => { console.error(error); process.exitCode = 1; });
}

async function fixture(mode) {
  const errors = [];
  const bookingRenderEvents = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8'), {
    url: 'https://example.test/MemberWebsocket-dev/booking/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.addEventListener('booking:bookings-rendered', (event) => bookingRenderEvents.push(event.detail));
  const el = id => w.document.getElementById(id);
  const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
  let subscriptions = 0;
  const calls = [];
  const serviceId = '20000000-0000-4000-8000-000000000001';
  const bookingId = '30000000-0000-4000-8000-000000000001';
  const technicianId = '40000000-0000-4000-8000-000000000001';
  const item = { serviceId, serviceTitle: '腳底40', unitDurationMinutes: 40, unitPriceAmount: 800, quantity: 1 };
  const booking = { bookingId, bookingDate: '2099-01-02', startTime: '09:00', endTime: '09:50', status: 'confirmed', totalDurationMinutes: 50, totalAmount: 800, items: [item] };
  const base = { today: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }), settings: { minAdvanceDays: 0, workStartTime: '09:00', workEndTime: '18:00' }, services: [{ serviceId, title: '腳底40', durationMinutes: 40, priceAmount: 800, isActive: true }], bookings: [booking] };
  const config = { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key', bookingLiffId: 'fixture-liff' };
  w.matchMedia = () => ({ matches: false });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.liff = { init: async () => {}, isLoggedIn: () => true, isInClient: () => true, getIDToken: () => 'fixture-token' };
  w.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.action || 'calendar');
    let data = {};
    if (body.action === 'user.member.bootstrap') data = { profile: { displayName: '測試', membershipRequired: mode === 'membership-required' } };
    if (body.action === 'user.booking.group.bootstrap') {
      if (mode === 'group-error') return new Response(JSON.stringify({ ok: false, error: { code: 'API_ERROR', message: '多人預約讀取失敗' } }), { status: 503 });
      data = { settings: { maxPartySize: 3, primaryTechnicianId: technicianId }, technicians: [{ technicianId, name: '測試技師', isActive: true }], bookingGroups: { [bookingId]: { partySize: 1, participants: [{ technicianId, technicianName: '測試技師', items: [item] }] } } };
    }
    if (body.action === 'user.booking.group.slots') data = { slots: [{ startTime: '10:00', endTime: '10:50', available: true }] };
    return new Response(JSON.stringify({ ok: true, data }));
  };
  w.BookingSystem = {
    loadConfig: async () => config, signIn: async () => 'fixture-token', completeSignIn: async (_config, _type, idToken) => idToken, memberProfile: async () => ({}),
    subscribeRealtime: () => { subscriptions++; return () => {}; },
    addDays: (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10),
    formatDate: date => date, clientError: (code, message) => Object.assign(new Error(message), { code }),
    request: async () => {
      if (mode === 'unauthorized') throw Object.assign(new Error('登入已失效'), { code: 'AUTH_INVALID' });
      return structuredClone(base);
    },
  };
  try {
    // Evaluate the actual entrypoint order, including all runtime extensions.
    for (const script of w.document.querySelectorAll('script[src]')) {
      const src = script.getAttribute('src');
      if (!src.startsWith('.') || src.startsWith('./common.js')) continue;
      w.eval(fs.readFileSync(path.resolve(root, 'booking', src.split('?')[0]), 'utf8'));
    }
    await tick(600);
    assert.deepEqual(errors, []);
    if (mode !== 'success') {
      assert.equal(el('errorView').classList.contains('hidden'), false);
      assert.equal(el('bookingView').classList.contains('hidden'), true);
      assert.equal(subscriptions, 0);
      assert.ok(el('errorMessage').textContent);
      return;
    }
    assert.equal(el('bookingView').classList.contains('hidden'), false);
    assert.equal(subscriptions, 1);
    assert.ok(bookingRenderEvents.length > 0, 'Bootstrap must publish the signed-in member booking times to calendar');
    assert.deepEqual(
      JSON.parse(JSON.stringify(bookingRenderEvents.at(-1).bookings)),
      [{ bookingDate: booking.bookingDate, startTime: booking.startTime, endTime: booking.endTime,
        status: booking.status }],
      'Only booking date/time/status should be published, not member identity or private notes'
    );
    const bookingCard = el('bookingList').querySelector('.booking-item[data-booking-id]');
    assert.ok(bookingCard, 'Booking history card should render');
    assert.equal(bookingCard.querySelector('details.member-booking-details'), null, 'Booking history should not contain a second details toggle');
    assert.match(bookingCard.querySelector('.booking-service-items, .group-history-summary')?.textContent || '', /腳底40/, 'Service details remain in individual or group booking cards');
    const bookingHeader = bookingCard.querySelector(':scope > .booking-item-top');
    assert.equal(bookingHeader?.getAttribute('aria-expanded'), 'false');
    bookingHeader.click();
    assert.equal(bookingHeader.getAttribute('aria-expanded'), 'true', 'Card header expands booking details directly');
    bookingHeader.click();
    assert.equal(bookingHeader.getAttribute('aria-expanded'), 'false', 'Card header collapses booking details');
    assert.equal(w.document.querySelectorAll('[data-group-history]').length, 1);
    const date = w.document.querySelector('.calendar-day.today');
    assert.ok(date);
    date.click();
    assert.equal(el('bookingDayModal')?.classList.contains('hidden'), false, 'Date opens records before booking');
    assert.equal(el('appointmentPanel').classList.contains('hidden'), true);
    assert.equal(el('bookingList').querySelectorAll('[data-booking-id]').length, 0, 'Other dates do not leak into the selected day');
    el('startDayBookingButton').click();
    assert.equal(el('appointmentPanel').classList.contains('hidden'), false);
    w.document.querySelector('.service-add-button').click();
    await tick(100);
    assert.ok(calls.includes('user.booking.group.slots'));
    assert.ok(el('slotGrid').querySelector('button'));
    assert.equal(w.document.querySelectorAll('[data-group-history]').length, 0, 'Other-day group cards stay out of the date dialog');
    const before = calls.length;
    await tick(500);
    assert.ok(calls.length - before <= 1, 'Idle UI must not repeatedly fetch');
  } finally { w.close(); }
}
