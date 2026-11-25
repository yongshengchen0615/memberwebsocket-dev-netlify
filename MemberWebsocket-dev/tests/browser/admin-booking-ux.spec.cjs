const { test, expect } = require('playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function mount(page) {
  await page.route('https://fixture.test/admin-booking-ux', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
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
  // Confirm fixture strings survive UTF-8 decoding; otherwise the action guard
  // would silently receive mojibake and never match the protected operation.
  await expect(page.locator('#confirmBooking')).toHaveAttribute('data-booking-admin-action', '確認預約');
  await expect.poll(() => page.evaluate(() => document.characterSet)).toBe('UTF-8');
  // Replace the native UI prompt only; keep the real Chromium capture/target/bubble
  // event dispatch and both original mutation listeners under test.
  await page.evaluate(() => {
    window.bookingConfirmationCalls = [];
    window.approveBookingMutation = false;
    window.confirm = message => {
      window.bookingConfirmationCalls.push(message);
      return window.approveBookingMutation;
    };
  });
  await page.locator('#confirmBooking').click();
  await expect(page.locator('#actionCount')).toHaveText('0');
  await page.locator('#bookingAdminSettingsForm button').click();
  await expect(page.locator('#submitCount')).toHaveText('0');
  await page.evaluate(() => { window.approveBookingMutation = true; });
  await page.locator('#confirmBooking').click();
  await expect(page.locator('#actionCount')).toHaveText('1');
  await page.locator('#bookingAdminSettingsForm button').click();
  await expect(page.locator('#submitCount')).toHaveText('1');
  const dialogs = await page.evaluate(() => window.bookingConfirmationCalls);
  expect(dialogs).toHaveLength(4);
  expect(dialogs[0]).toContain('2026-11-23');
  expect(dialogs[1]).toContain('儲存預約');
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


// Render the production reservation summary functions in a real browser DOM.
test('AC-010/011 Chromium: member reminder preference is visible to admins without implying delivery', async ({ page }) => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  };
  const functions = [
    section('  function bookingReminderSummary(', '  function renderBookingSummary('),
    section('  function renderBookingSummary(', '  function summaryMetaItem('),
    section('  function summaryMetaItem(', '  function renderParticipantDetails('),
  ].join('\n');
  const cases = [
    { booking: { bookingSource: 'member', reminderEnabled: true, reminderTime: '09:30' }, expected: '已設定｜預約前一天 09:30（台灣時間）' },
    { booking: { bookingSource: 'member', reminderEnabled: false, reminderTime: '18:00' }, expected: '未設定' },
    { booking: { bookingSource: 'member' }, expected: '資料未同步' },
    { booking: { bookingSource: 'phone', reminderEnabled: false }, expected: null },
  ];
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent('<!doctype html><html lang="zh-Hant"><body></body></html>');
    for (const { booking, expected } of cases) {
      await page.evaluate(({ functions, booking }) => {
        const prefix = [
          "function isPhoneBooking(row) { return row.bookingSource === 'phone'; }",
          "function isFrontdeskReplacement() { return false; }",
          "function formatMoney(amount) { return 'NT$ ' + amount; }",
          "function formatBookingDateSummary(date) { return date; }",
          "function bookingContactName(row) { return row.memberDisplayName || '測試會員'; }",
          "function renderParticipantDetails() { return document.createElement('div'); }",
        ].join('\n');
        const makeSummary = new Function('booking', prefix + '\n' + functions
          + '\nreturn renderBookingSummary(booking, { participants: [] }, false);');
        document.body.replaceChildren(makeSummary({
          bookingId: 'B-1', bookingDate: '2026-12-12', startTime: '10:00', endTime: '11:00',
          memberDisplayName: '測試會員', ...booking,
        }));
      }, { functions, booking });
      const meta = page.locator('.booking-member-meta');
      if (expected) {
        await expect(meta).toContainText('LINE 預約提醒');
        await expect(meta).toContainText(expected);
      } else {
        await expect(meta).not.toContainText('LINE 預約提醒');
      }
      await expect(meta).not.toContainText('已發送');
    }
  }
});
