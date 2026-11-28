const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

async function fixture(search = '') {
  const dom = new JSDOM(read('booking/index.html'), { url: 'https://example.test/booking/' + search, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // Pin the fixture's clock to its declared October baseline so these
  // navigation expectations also hold across month/year rollovers.
  const BrowserDate = w.Date;
  const fixedNow = BrowserDate.parse('2026-10-30T12:00:00+08:00');
  w.Date = class extends BrowserDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  w.matchMedia = () => ({ matches: false });
  w.BookingSystem = { formatDate: value => value };
  w.eval(read('booking/booking-accessible.js'));
  w.eval(read('booking/booking-receipt.js'));
  w.eval(read('booking/calendar-flow.js'));
  await new Promise(resolve => w.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const emit = (name, detail) => w.dispatchEvent(new w.CustomEvent(name, { detail }));
  emit('booking:settings-updated', { today: '2026-10-30', settings: { minAdvanceDays: 1, maxAdvanceDays: 5 } });
  return { dom, w, emit, el: id => w.document.getElementById(id), click: date => w.document.querySelector('[data-date="' + date + '"]').click() };
}

test('past and advance-blocked dates open records while start remains disabled; previous months are readable', async () => {
  const f = await fixture();
  try {
    for (const date of ['2026-10-29', '2026-10-30']) {
      f.click(date);
      assert.equal(f.el('bookingDayModal')?.classList.contains('hidden'), false);
      assert.equal(f.el('startDayBookingButton').disabled, true);
      f.el('startDayBookingButton').click();
      assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true);
    }
    f.el('closeBookingDayButton').click();
    f.el('previousMonthButton').click();
    assert.match(f.el('calendarMonthLabel').textContent, /9 月/);
  } finally { f.w.close(); }
});

test('available day opens original form only after start; close returns to the same day records', async () => {
  const f = await fixture();
  try {
    f.click('2026-10-31');
    assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true);
    assert.equal(f.el('startDayBookingButton')?.disabled, false);
    f.el('startDayBookingButton').click();
    assert.equal(f.el('bookingDate').value, '2026-10-31');
    assert.equal(f.el('appointmentPanel').classList.contains('hidden'), false);
    assert.equal(f.el('bookingDayModal').classList.contains('hidden'), true);
    f.el('closeAppointmentButton').click();
    assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true);
    assert.equal(f.el('bookingDayModal').classList.contains('hidden'), false);
    assert.match(f.el('bookingDayTitle').textContent, /2026-10-31/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.w.document.activeElement.id, 'closeBookingDayButton');
    f.el('closeBookingDayButton').click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.el('bookingDayModal').classList.contains('hidden'), true);
    assert.equal(f.w.document.activeElement.dataset.date, '2026-10-31');
  } finally { f.w.close(); }
});

test('telephone booking appears only on dates blocked from online booking within the merchant horizon', async () => {
  const f = await fixture();
  try {
    f.emit('booking:settings-updated', { today: '2026-10-30', settings: { minAdvanceDays: 2, maxAdvanceDays: 4, phoneBookingNumber: '06-1234567' } });
    f.click('2026-10-30');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.equal(f.el('startDayBookingButton').hidden, true);
    assert.equal(f.el('bookingPhoneFallback').hidden, false);
    assert.equal(f.el('bookingPhoneDial').getAttribute('href'), 'tel:061234567');

    f.el('nextMonthButton').click();
    f.click('2026-11-01');
    assert.equal(f.el('startDayBookingButton').disabled, false);
    assert.equal(f.el('startDayBookingButton').hidden, false);
    assert.equal(f.el('bookingPhoneFallback').hidden, true);
    assert.equal(f.el('bookingPhoneDial').hasAttribute('href'), false);

    f.click('2026-11-04');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.equal(f.el('bookingPhoneFallback').hidden, true);
    assert.equal(f.el('bookingPhoneDial').hasAttribute('href'), false);
  } finally { f.w.close(); }
});

test('Escape and mobile backdrop return to selected day without closing the day history', async () => {
  const f = await fixture();
  try {
    for (const mode of ['Escape', 'backdrop']) {
      f.click('2026-10-31');
      f.el('startDayBookingButton').click();
      if (mode === 'Escape') {
        f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        f.w.matchMedia = () => ({ matches: true });
        f.el('appointmentPanel').dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
      }
      assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true, mode);
      assert.equal(f.el('bookingDayModal').classList.contains('hidden'), false, mode);
      assert.match(f.el('bookingDayTitle').textContent, /2026-10-31/, mode);
      f.el('closeBookingDayButton').click();
      assert.equal(f.el('bookingDayModal').classList.contains('hidden'), true, mode);
    }
  } finally { f.w.close(); }
});

test('booking creation returns from the appointment flow to updated day records', async () => {
  const f = await fixture();
  try {
    f.click('2026-10-31');
    f.el('startDayBookingButton').click();
    f.emit('booking:created', { booking: { bookingDate: '2026-10-31' } });
    assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true);
    assert.equal(f.el('bookingDayModal').classList.contains('hidden'), false);
    assert.match(f.el('bookingDayTitle').textContent, /2026-10-31/);
  } finally { f.w.close(); }
});

test('snapshot date uses Taipei midnight and refresh stays scoped; identity change clears history', async () => {
  const f = await fixture();
  try {
    f.emit('booking:member-loaded', { profile: { lineUserId: 'a' } });
    const rows = [
      { receiptId: 'before-midnight', createdAt: '2026-10-29T15:59:00Z', status: 'awaiting_review' },
      { receiptId: 'after-midnight', createdAt: '2026-10-29T16:00:00Z', status: 'bound' },
    ];
    f.emit('booking:receipts-updated', { submissions: rows });
    f.click('2026-10-30');
    const records = () => [...f.el('bookingSnapshotHistory').querySelectorAll('[data-receipt-id]')].map(n => n.dataset.receiptId);
    assert.deepEqual(records(), ['after-midnight']);
    f.emit('booking:receipts-updated', { submissions: rows });
    assert.deepEqual(records(), ['after-midnight']);
    f.click('2026-10-31');
    assert.deepEqual(records(), []);
    assert.equal(f.el('bookingSnapshotDayEmpty').hidden, false);
    f.emit('booking:member-loaded', { profile: { lineUserId: 'b' } });
    assert.equal(f.el('bookingDayModal').classList.contains('hidden'), true);
    assert.deepEqual(records(), []);
  } finally { f.w.close(); }
});

test('receipt deep link opens its Taipei date inside calendar dialog', async () => {
  const f = await fixture('?receiptId=target');
  try {
    f.emit('booking:receipts-updated', { submissions: [{ receiptId: 'target', createdAt: '2026-09-01T16:00:00Z', status: 'bound' }] });
    assert.equal(f.el('bookingDayModal')?.classList.contains('hidden'), false);
    assert.match(f.el('bookingDayTitle').textContent, /2026-09-02/);
    assert.equal(f.el('bookingSnapshotHistory').querySelector('[data-receipt-id="target"]').open, true);
  } finally { f.w.close(); }
});

test('holiday and maximum-range dates show records without enabling start, including fresh policy changes', async () => {
  const f = await fixture();
  try {
    f.w.BookingSystem.loadConfig = async () => ({ supabaseUrl: 'https://fixture.supabase.co' });
    f.w.liff = { isLoggedIn: () => true, getIDToken: () => 'fixture' };
    f.w.fetch = async () => new Response(JSON.stringify({ ok: true, data: { settings: { maxAdvanceDays: 1 }, holidays: [{ startsOn: '2026-10-31', endsOn: '2026-10-31', title: '店休', description: '當日不營業' }] } }));
    f.emit('booking:view-shown');
    await new Promise(resolve => setTimeout(resolve, 20));
    f.click('2026-10-31');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.equal(f.el('startDayBookingButton').hidden, true);
    assert.equal(f.el('bookingPhoneFallback').hidden, true);
    assert.equal(f.el('bookingDayHolidayNotice').hidden, false);
    assert.match(f.el('bookingDayHolidayNotice').textContent, /休假提醒.*當日無法預約/);
    assert.match(f.el('bookingDayHint').textContent, /休假/);
    assert.match(f.el('bookingDayHolidayDetails').textContent, /當日不營業/);
    f.el('nextMonthButton').click();
    f.click('2026-11-02');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.match(f.el('bookingDayHint').textContent, /超過可預約範圍/);
  } finally { f.w.close(); }
});

test('Escape closes only the receipt over date records, leaving the selected day open', async () => {
  const f = await fixture();
  try {
    f.click('2026-10-31');
    f.w.BookingReceipts.openBooking('booking', 'version', false, { skipCamera: true });
    f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(f.el('bookingReceiptModal').classList.contains('hidden'), true);
    assert.equal(f.el('bookingDayModal').classList.contains('hidden'), false);
  } finally { f.w.close(); }
});

test('date dialog hidden empty and holiday elements do not override the native hidden state', async () => {
  const f = await fixture();
  try {
    for (const link of f.w.document.querySelectorAll('link[rel="stylesheet"]')) {
      const href = link.getAttribute('href').split('?')[0];
      if (!href.startsWith('.')) continue;
      const style = f.w.document.createElement('style');
      style.textContent = fs.readFileSync(path.resolve(root, 'booking', href), 'utf8');
      f.w.document.head.append(style);
    }
    f.emit('booking:receipts-updated', { submissions: [{ receiptId: 'one', createdAt: '2026-10-30T00:00:00Z', status: 'bound' }] });
    f.click('2026-10-30');
    for (const id of ['bookingSnapshotDayEmpty', 'bookingDayHolidayDetails']) {
      assert.equal(f.el(id).hidden, true);
      assert.equal(f.w.getComputedStyle(f.el(id)).display, 'none', id);
    }
  } finally { f.w.close(); }
});

for (const testMode of [false, true]) {
  test(`merchant calendar request passes the real booking action policy on entry and month changes (${testMode ? 'test session' : 'LINE'})`, async () => {
    const { assertBusinessAction } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/business-policy.mjs')));
    const context = { status: 'active', runtime_schema: 'business_' + 'a'.repeat(32), features: { booking: true, calendar: false } };
    const errors = [], observers = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(read('booking/index.html'), { url: 'https://example.test/booking/?business=merchant-a', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
    const w = dom.window, requests = [], denied = [];
    const NativeObserver = w.MutationObserver;
    w.MutationObserver = class extends NativeObserver {
      constructor(callback) { super(callback); observers.push(this); }
    };
    let resolveRequest;
    const nextRequest = () => new Promise(resolve => { resolveRequest = resolve; });
    w.matchMedia = () => ({ matches: false });
    w.liff = { isLoggedIn: () => true, getIDToken: () => 'synthetic-line-token' };
    if (testMode) w.TestModeClient = { getSessionToken: () => 'synthetic-session', payload: body => ({ ...body, testSessionToken: 'synthetic-session' }) };
    w.BookingSystem = { loadConfig: async () => ({ supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' }), formatDate: date => date };
    w.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      let response;
      try {
        assertBusinessAction(context, body.action || '', body);
        response = new Response(JSON.stringify({ ok: true, data: { occupiedDates: [{ date: body.month + '-01', intervals: [{ startTime: '09:00', endTime: '10:00' }] }] } }));
      } catch (error) {
        denied.push(error.code);
        response = new Response(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }), { status: error.status });
      }
      resolveRequest?.();
      return response;
    };
    w.eval(read('business-context.js'));
    w.eval(read('booking/calendar-flow.js'));
    try {
      await new Promise(resolve => w.addEventListener('DOMContentLoaded', resolve, { once: true }));
      for (const trigger of [() => w.dispatchEvent(new w.CustomEvent('booking:view-shown')), () => w.document.getElementById('previousMonthButton').click(), () => w.document.getElementById('nextMonthButton').click()]) {
        const requestDone = nextRequest();
        trigger();
        await requestDone;
        await new Promise(resolve => setTimeout(resolve, 0));
        const { body } = requests.at(-1);
        assert.deepEqual(denied, [], 'Authorized booking-only tenant must not hit FEATURE_ACTION_UNMAPPED');
        assert.equal(body.action, 'user.booking.calendar');
        assert.equal(body.business, 'merchant-a');
        assert.equal(body.idToken, testMode ? '' : 'synthetic-line-token');
        assert.equal(body.testSessionToken, testMode ? 'synthetic-session' : undefined);
        assert.ok(w.document.querySelector(`[data-date="${body.month}-01"] .calendar-booking-times`));
        assert.throws(() => assertBusinessAction({ ...context, features: { booking: false, calendar: true } }, body.action, body), error => error.code === 'FEATURE_DISABLED');
        assert.throws(() => assertBusinessAction({ ...context, status: 'suspended' }, body.action, body), error => error.code === 'TENANT_SUSPENDED');
      }
      assert.notEqual(requests[0].body.month, requests[1].body.month);
      assert.equal(requests[0].body.month, requests[2].body.month);
    } finally {
      observers.forEach(observer => observer.disconnect());
      w.close();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(errors, [], 'Merchant fixture must have no uncaught browser errors');
    }
  });
}

test('phone-only dates expose a read-only catalog and revoke it on date or identity changes', async () => {
  const f = await fixture();
  try {
    f.emit('booking:settings-updated', { today: '2026-10-30', settings: { minAdvanceDays: 2, maxAdvanceDays: 4, phoneBookingNumber: '06-1234567' } });
    f.emit('booking:services-updated', { services: [
      { serviceId: 'a', title: '深層保養', durationMinutes: 60, priceAmount: 900, description: '__TYPE__:保養' },
      { serviceId: 'b', title: '基礎保養', durationMinutes: 30, priceAmount: 400, description: '__TYPE__:保養' },
      { serviceId: 'c', title: '<img src=x onerror=alert(1)>', durationMinutes: 15, priceAmount: 200, description: '__TYPE__:加購', requiresCompanionService: true },
    ] });
    f.click('2026-10-30');
    assert.equal(f.el('bookingPhoneServiceReference').hidden, false);
    assert.match(f.el('bookingPhoneServiceReference').textContent, /電話預約項目參考/);
    const items = [...f.el('bookingPhoneServiceList').querySelectorAll('.booking-phone-service-item')];
    assert.deepEqual(items.map(item => item.querySelector('span').textContent), ['基礎保養', '深層保養', '<img src=x onerror=alert(1)>']);
    assert.match(items[0].textContent, /30 分鐘.*NT\$400/);
    assert.match(items[2].textContent, /加購／需搭配一般項目/);
    assert.equal(f.el('bookingPhoneServiceList').querySelectorAll('button,input,img').length, 0);
    assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true);
    f.el('nextMonthButton').click();
    f.click('2026-11-01');
    assert.equal(f.el('bookingPhoneServiceReference').hidden, true);
    assert.equal(f.el('bookingPhoneServiceList').children.length, 0);
    f.click('2026-11-04');
    assert.equal(f.el('bookingPhoneServiceReference').hidden, true);
    f.emit('member:access-ended');
    assert.equal(f.el('bookingPhoneServiceReference').hidden, true);
    assert.equal(f.el('bookingPhoneServiceList').children.length, 0);
  } finally { f.w.close(); }
});

test('phone-only item reference handles empty catalogs and revoked telephone settings', async () => {
  const f = await fixture();
  try {
    f.emit('booking:settings-updated', { today: '2026-10-30', settings: { minAdvanceDays: 2, maxAdvanceDays: 4, phoneBookingNumber: '06-1234567' } });
    f.click('2026-10-30');
    assert.match(f.el('bookingPhoneServiceList').textContent, /沒有開放的預約項目/);
    f.emit('booking:services-updated', { services: [{ serviceId: 'a', title: '參考服務', durationMinutes: 45, priceAmount: 600 }] });
    assert.match(f.el('bookingPhoneServiceList').textContent, /參考服務/);
    f.emit('booking:settings-updated', { today: '2026-10-30', settings: { minAdvanceDays: 2, maxAdvanceDays: 4, phoneBookingNumber: '' } });
    assert.equal(f.el('bookingPhoneServiceReference').hidden, true);
    assert.equal(f.el('bookingPhoneServiceList').children.length, 0);
  } finally { f.w.close(); }
});

test('technician leave dates replace every booking action with a technician leave reminder', async () => {
  const f = await fixture();
  try {
    f.w.BookingSystem.loadConfig = async () => ({ supabaseUrl: 'https://fixture.supabase.co' });
    f.w.liff = { isLoggedIn: () => true, getIDToken: () => 'fixture' };
    f.w.fetch = async () => new Response(JSON.stringify({ ok: true, data: {
      settings: { minAdvanceDays: 2, maxAdvanceDays: 4, phoneBookingNumber: '06-1234567' },
      holidays: [{ startsOn: '2026-10-31', endsOn: '2026-10-31', title: '技師休假', description: '技師休息一天' }]
    } }));
    f.emit('booking:view-shown');
    await new Promise(resolve => setTimeout(resolve, 20));
    f.click('2026-10-31');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.equal(f.el('startDayBookingButton').hidden, true);
    assert.equal(f.el('bookingPhoneFallback').hidden, true);
    assert.equal(f.el('bookingPhoneDial').hasAttribute('href'), false);
    assert.equal(f.el('bookingPhoneServiceReference').hidden, true);
    assert.equal(f.el('bookingDayHolidayNotice').hidden, false);
    assert.match(f.el('bookingDayHolidayNotice').textContent, /技師休假提醒.*當日無法預約/);
    assert.match(f.el('bookingDayHolidayDetails').textContent, /技師休息一天/);
    assert.equal(f.el('appointmentPanel').classList.contains('hidden'), true);
    f.el('nextMonthButton').click();
    f.click('2026-11-01');
    assert.equal(f.el('bookingDayHolidayNotice').hidden, true);
    assert.equal(f.el('bookingDayHolidayNotice').textContent, '');
  } finally { f.w.close(); }
});

test('AC-RANGE-004: holiday styling separates booking window, history access and holiday identity', async () => {
  const f = await fixture();
  try {
    f.w.BookingSystem.loadConfig = async () => ({ supabaseUrl: 'https://fixture.supabase.co' });
    f.w.liff = { isLoggedIn: () => true, getIDToken: () => 'fixture' };
    const holidays = [
      { startsOn: '2026-10-29', endsOn: '2026-10-29', title: '過去休假' },
      { startsOn: '2026-10-31', endsOn: '2026-10-31', title: '提前限制休假' },
      { startsOn: '2026-11-01', endsOn: '2026-11-01', title: '範圍內休假' },
      { startsOn: '2026-11-04', endsOn: '2026-11-04', title: '超過最遠休假' },
    ];
    f.w.fetch = async () => new Response(JSON.stringify({
      ok: true, data: { settings: { minAdvanceDays: 2, maxAdvanceDays: 4 }, holidays },
    }));
    f.emit('booking:view-shown');
    await new Promise(resolve => setTimeout(resolve, 20));

    const day = date => f.w.document.querySelector('[data-date="' + date + '"]');
    assert.equal(day('2026-10-29').classList.contains('past-disabled'), true);
    assert.equal(day('2026-10-29').classList.contains('holiday-disabled'), true);
    assert.equal(day('2026-10-31').classList.contains('advance-disabled'), true);
    assert.equal(day('2026-10-31').classList.contains('holiday-disabled'), true);
    assert.match(day('2026-10-31').title, /尚未開放線上預約/);
    f.click('2026-10-31');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.equal(f.el('bookingDayHolidayNotice').hidden, false);

    f.el('nextMonthButton').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(day('2026-11-01').classList.contains('holiday-disabled'), true);
    assert.equal(day('2026-11-01').classList.contains('advance-disabled'), false);
    assert.equal(day('2026-11-04').classList.contains('holiday-disabled'), true);
    assert.equal(day('2026-11-04').classList.contains('advance-disabled'), true);
    assert.match(day('2026-11-04').title, /超過可預約範圍/);
    assert.equal(day('2026-11-05').classList.contains('advance-disabled'), true);
    assert.equal(day('2026-11-05').classList.contains('holiday-disabled'), false);
    f.click('2026-11-04');
    assert.equal(f.el('startDayBookingButton').disabled, true);
    assert.equal(f.el('bookingDayHolidayNotice').hidden, false);
    assert.equal(day('2026-11-04').disabled, false, 'day records stay accessible');
  } finally { f.w.close(); }
});
