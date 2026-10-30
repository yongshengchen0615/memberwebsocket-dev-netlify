const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/booking/') {
      const html = fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html.replace('</body>',
        '<script src="/booking-calendar-fixture.js" defer></script><script src="./calendar-flow.js" defer></script></body>'));
      return;
    }
    if (url.pathname === '/booking-calendar-fixture.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end([
        'window.BookingSystem = { loadConfig: async () => ({}), formatDate: value => value };',
        "window.addEventListener('DOMContentLoaded', () => document.getElementById('bookingView').classList.remove('hidden'));",
      ].join('\n'));
      return;
    }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'application/javascript' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

test.afterAll(async () => new Promise((resolve) => server.close(resolve)));

test.beforeEach(async ({ page }) => {
  await page.route('https://**', (route) => route.abort());
});

for (const width of [320, 390, 1280]) {
  test('calendar displays only active member reservation times at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(baseUrl + '/booking/');
    const date = await page.evaluate(() => {
      const parts = {};
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date()).forEach((item) => {
        if (item.type !== 'literal') parts[item.type] = item.value;
      });
      const date = parts.year + '-' + parts.month + '-' + parts.day;
      const bookings = [
        { bookingDate: date, startTime: '09:00', endTime: '09:50', status: 'pending' },
        { bookingDate: date, startTime: '15:00', endTime: '16:00', status: 'confirmed' },
        { bookingDate: date, startTime: '17:00', endTime: '18:00', status: 'cancel_requested' },
        { bookingDate: date, startTime: '20:00', endTime: '21:00', status: 'cancelled' },
        { bookingDate: date, startTime: '22:00', endTime: '23:00', status: 'completed' },
      ];
      window.dispatchEvent(new CustomEvent('booking:bookings-rendered', { detail: { bookings } }));
      return date;
    });
    const cell = page.locator('[data-date="' + date + '"]');
    await expect(cell).toBeVisible();
    await expect(cell.locator('.calendar-booking-times small')).toHaveCount(3);
    await expect(cell).toContainText('09:00');
    await expect(cell).toContainText('15:00');
    await expect(cell).toContainText('17:00');
    await expect(cell).not.toContainText('20:00');
    await expect(cell).not.toContainText('22:00');
    await expect(cell).toHaveAttribute('aria-label', /我的預約時間/);
    for (const time of await cell.locator('.calendar-booking-times small').all()) {
      await expect(time).toBeVisible();
      await expect(time).toHaveAttribute('title', /\d{2}:\d{2}–\d{2}:\d{2}/);
    }
    const end = cell.locator('.calendar-booking-end').first();
    if (width <= 520) await expect(end).toBeHidden();
    else await expect(end).toBeVisible();

    // Fresh authenticated-member state must not retain old or cancelled reservations.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('booking:bookings-rendered', { detail: { bookings: [] } }));
    });
    await expect(cell.locator('.calendar-booking-times')).toHaveCount(0);
  });
}

for (const testMode of [false, true]) {
  test('merchant calendar month requests use the booking grant (' + (testMode ? 'test session' : 'LINE') + ')', async ({ page }) => {
    const { pathToFileURL } = require('node:url');
    const { assertBusinessAction } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/business-policy.mjs')));
    const requests = [], denied = [];
    const context = { status: 'active', runtime_schema: 'business_' + 'a'.repeat(32), features: { booking: true, calendar: false } };
    await page.route('https://fixture.supabase.co/functions/v1/booking-calendar-api', async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      try {
        assertBusinessAction(context, body.action || '', body);
        await route.fulfill({ json: { ok: true, data: { occupiedDates: [{ date: body.month + '-01', intervals: [{ startTime: '09:00', endTime: '10:00' }] }] } } });
      } catch (error) {
        denied.push(error.code);
        await route.fulfill({ status: error.status, json: { ok: false, error: { code: error.code, message: error.message } } });
      }
    });
    await page.setViewportSize({ width: testMode ? 1280 : 390, height: 900 });
    await page.goto(baseUrl + '/booking/?business=merchant-a');
    await page.addScriptTag({ url: baseUrl + '/business-context.js' });
    await page.evaluate(testMode => {
      window.BookingSystem.loadConfig = async () => ({ supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' });
      window.liff = { isLoggedIn: () => true, getIDToken: () => 'synthetic-line-token' };
      if (testMode) window.TestModeClient = { getSessionToken: () => 'synthetic-session', payload: body => ({ ...body, testSessionToken: 'synthetic-session' }) };
      window.dispatchEvent(new CustomEvent('booking:settings-updated', { detail: { today: '2026-10-30', settings: {} } }));
    }, testMode);
    await expect(page.locator('[data-date="2026-10-01"] .calendar-booking-times')).toBeVisible();
    await page.locator('#previousMonthButton').click();
    await expect(page.locator('[data-date="2026-09-01"] .calendar-booking-times')).toBeVisible();
    await page.locator('#nextMonthButton').click();
    await expect(page.locator('[data-date="2026-10-01"] .calendar-booking-times')).toBeVisible();
    expect(denied).toEqual([]);
    expect(requests.map(body => body.month)).toEqual(['2026-10', '2026-09', '2026-10']);
    for (const body of requests) {
      expect(body.action).toBe('user.booking.calendar');
      expect(body.business).toBe('merchant-a');
      expect(body.idToken).toBe(testMode ? '' : 'synthetic-line-token');
      expect(body.testSessionToken).toBe(testMode ? 'synthetic-session' : undefined);
    }
  });
}
