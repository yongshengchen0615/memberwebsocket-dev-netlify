const { test, expect } = require('playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function mount(page) {
  await page.route('https://fixture.test/admin-booking-ux', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="zh-Hant"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body><article data-booking-id="B-1" data-booking-member-name="測試會員"
    data-booking-date="2026-11-23" data-booking-start-time="10:00"
    data-booking-end-time="11:00"><button type="button" id="confirmBooking" data-booking-admin-action="確認預約">確認預約</button></article>
    <form id="bookingAdminSettingsForm"><button type="submit">儲存預約設定</button></form>
    <p id="actionCount">0</p><p id="submitCount">0</p></body></html>`,
  }));
  await page.goto('https://fixture.test/admin-booking-ux');
  await page.addStyleTag({ path: path.join(root, 'admin/booking-admin-ux.css') });
  await page.evaluate(() => {
    window.bookingActionCount = 0;
    window.bookingSubmitCount = 0;
    document.querySelector('#confirmBooking').addEventListener('click', () => {
      window.bookingActionCount++;
      document.querySelector('#actionCount').textContent = String(window.bookingActionCount);
    });
    document.querySelector('#bookingAdminSettingsForm').addEventListener('submit', event => {
      event.preventDefault();
      window.bookingSubmitCount++;
      document.querySelector('#submitCount').textContent = String(window.bookingSubmitCount);
    });
  });
  await page.addScriptTag({ path: path.join(root, 'admin/booking-admin-ux.js') });
}

for (const width of [390, 1280]) test(`AC-003/004 Chromium ${width}px: cancel blocks mutations; deliberate confirmation permits them`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await mount(page);
  let approve = false;
  const dialogs = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    if (approve) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.locator('#confirmBooking').click();
  await expect(page.locator('#actionCount')).toHaveText('0');
  await page.locator('#bookingAdminSettingsForm button').click();
  await expect(page.locator('#submitCount')).toHaveText('0');
  approve = true;
  await page.locator('#confirmBooking').click();
  await expect(page.locator('#actionCount')).toHaveText('1');
  await page.locator('#bookingAdminSettingsForm button').click();
  await expect(page.locator('#submitCount')).toHaveText('1');
  expect(dialogs).toHaveLength(4);
  expect(dialogs[0]).toContain('2026-11-23');
  expect(dialogs[2]).toContain('確認預約');
});

test('AC-001/002 Chromium: loading lasts through parallel writes, ignores reads, and releases after backend failure', async ({ page }) => {
  await mount(page);
  const held = [];
  await page.route('https://fixture.supabase.co/functions/v1/**', async route => {
    await new Promise(resolve => held.push(async status => {
      await route.fulfill({ status, json: status === 200 ? { ok: true, data: {} } : { ok: false, error: { code: 'API_ERROR' } } });
      resolve();
    }));
  });
  const write = action => ({
    method: 'POST',
    body: JSON.stringify({ clientType: 'admin', action }),
  });
  await page.evaluate(configure => {
    window.first = fetch('https://fixture.supabase.co/functions/v1/booking-api', configure.first);
    window.second = fetch('https://fixture.supabase.co/functions/v1/booking-admin-api', configure.second);
  }, { first: write('admin.booking.status.update'), second: write('admin.booking.settings.save') });
  await expect.poll(() => held.length).toBe(2);
  const overlay = page.locator('#adminBookingPendingOverlay');
  await expect(overlay).toBeVisible();
  await held[0](200);
  await page.evaluate(() => window.first);
  await expect(overlay).toBeVisible();
  await held[1](500);
  await page.evaluate(() => window.second);
  await expect(overlay).toBeHidden();
  await page.evaluate(() => {
    window.read = fetch('https://fixture.supabase.co/functions/v1/booking-api', {
      method: 'POST', body: JSON.stringify({ clientType: 'admin', action: 'admin.booking.bootstrap' }),
    });
  });
  await expect.poll(() => held.length).toBe(3);
  await expect(overlay).toBeHidden();
  await held[2](200);
  await page.evaluate(() => window.read);
  await expect(overlay).toBeHidden();
});
