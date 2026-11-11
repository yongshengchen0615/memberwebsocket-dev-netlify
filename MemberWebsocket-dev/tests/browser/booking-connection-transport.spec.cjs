const { test, expect } = require('playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const config = { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'public-fixture', pricePublishing: true };
async function mount(page) {
  const calls = [], waiting = []; let hold = false, status = 200, code = '';
  await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>.hidden{display:none}</style><main id="bookingView">Protected bookings</main><div role="dialog">Protected draft</div>' }));
  await page.route('https://fixture.supabase.co/**', async route => {
    const body = route.request().postDataJSON(); calls.push({ url: route.request().url(), body });
    const responseStatus = status, responseCode = code;
    if (hold) await new Promise(resolve => waiting.push(resolve));
    let data = {};
    if (body.action === 'user.booking.bootstrap') data = { settings: {}, services: [{ serviceId: 'S', title: 'Fixture', priceAmount: 100, durationMinutes: 30, priceVersion: 4 }], bookings: [] };
    if (body.action === 'user.booking.group.bootstrap') data = { settings: { requirePrimaryTechnician: false }, technicians: [], bookingGroups: {} };
    if (body.action === 'user.booking.group.slots') data = { slots: ['10:00'] };
    await route.fulfill({ status: responseStatus, json: responseCode ? { ok: false, error: { code: responseCode, message: 'fixture' } } : { ok: true, data } });
  });
  await page.goto('https://fixture.test/booking/');
  for (const file of ['booking-price-publishing.js', 'booking/common.js', 'booking/group-booking.js']) await page.addScriptTag({ path: path.join(root, file) });
  await page.evaluate(async config => {
    window.fixtureConfig = config;
    window.fixtureSlots = (date = '2026-11-11', token = 'identity-A') => BookingSystem.request(config, 'member', token, 'user.booking.slots', { bookingDate: date, items: [{ serviceId: 'S', quantity: 1 }] });
    await BookingSystem.request(config, 'member', 'identity-A', 'user.booking.bootstrap');
  }, config);
  return { calls, hold() { hold = true; }, stopHolding() { hold = false; }, release() { hold = false; waiting.splice(0).forEach(resolve => resolve()); }, fail(value, error) { status = value; code = error; } };
}
for (const width of [390, 1280]) test(`AC-001 Chromium ${width}: actual group wrapper coalesces bursts and preserves price snapshots`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const h = await mount(page);
  try {
    const before = h.calls.length; h.hold();
    await page.evaluate(() => { window.burst = Promise.all(Array.from({ length: 100 }, () => window.fixtureSlots())); });
    await expect.poll(() => h.calls.length - before).toBe(1);
    const call = h.calls.at(-1);
    expect(call.url).toBe(config.supabaseUrl + '/functions/v1/booking-group-slots-api');
    expect(call.body.expectedPrices).toEqual([{ serviceId: 'S', priceAmount: 100, priceVersion: 4 }]);
    expect(call.body.participants[0]).toEqual({ technicianId: null, items: [{ serviceId: 'S', quantity: 1 }], memberNote: '' });
    h.release(); expect((await page.evaluate(() => window.burst)).length).toBe(100);
    await page.evaluate(() => window.fixtureSlots()); expect(h.calls.length - before).toBe(2);
    h.hold(); const separate = h.calls.length;
    await page.evaluate(() => { window.separate = Promise.all([window.fixtureSlots('2026-11-12'), window.fixtureSlots('2026-11-13'), window.fixtureSlots('2026-11-12', 'identity-B')]); });
    await expect.poll(() => h.calls.length - separate).toBe(3); h.release(); await page.evaluate(() => window.separate);
  } finally { h.release(); }
});
test('AC-003 Chromium: 429 is shared only in flight and a fresh request can recover', async ({ page }) => {
  const h = await mount(page); try {
    h.fail(429, 'RATE_LIMITED'); h.hold(); const before = h.calls.length;
    await page.evaluate(() => { window.failed = Promise.allSettled([window.fixtureSlots(), window.fixtureSlots()]); });
    await expect.poll(() => h.calls.length - before).toBe(1); h.release();
    expect(await page.evaluate(async () => (await window.failed).map(result => result.reason.code))).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
    h.fail(200, ''); await page.evaluate(() => window.fixtureSlots()); expect(h.calls.length - before).toBe(2);
  } finally { h.release(); }
});

test('AC-005 Chromium: revoked group access hides protected views and late success cannot reopen them', async ({ page }) => {
  const h = await mount(page); try {
    await page.evaluate(() => {
      window.accessEnded = [];
      window.addEventListener('member:access-ended', event => window.accessEnded.push(event.detail.code));
      window.alert = () => {};
      window.liff = { isLoggedIn: () => false, closeWindow() {} };
    });
    await expect(page.locator('#bookingView')).toBeVisible();
    h.hold(); const before = h.calls.length;
    await page.evaluate(() => { window.late = window.fixtureSlots().then(() => 'unexpected success', error => error.code); });
    await expect.poll(() => h.calls.length - before).toBe(1);
    h.stopHolding(); h.fail(401, 'SESSION_REVOKED');
    expect(await page.evaluate(() => BookingSystem.request(window.fixtureConfig, 'member', 'identity-A', 'user.booking.group.bootstrap').then(() => 'unexpected success', error => error.code))).toBe('SESSION_REVOKED');
    await expect(page.locator('#bookingView')).toBeHidden(); await expect(page.locator('[role=dialog]')).toBeHidden();
    expect(await page.evaluate(() => window.accessEnded)).toEqual(['SESSION_REVOKED']);
    h.release(); expect(await page.evaluate(() => window.late)).toBe('SESSION_REVOKED');
    await expect(page.locator('#bookingView')).toBeHidden(); await expect(page.locator('[role=dialog]')).toBeHidden();
    const count = h.calls.length;
    expect(await page.evaluate(() => window.fixtureSlots().then(() => 'unexpected success', error => error.code))).toBe('SESSION_REVOKED');
    expect(h.calls.length).toBe(count);
  } finally { h.release(); }
});
