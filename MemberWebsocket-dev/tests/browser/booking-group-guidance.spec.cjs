const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('mobile group booking scrolls expanded technician field into view and highlights missing services', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.setContent(`<!doctype html><html lang="zh-Hant"><body>
    <section id="appointmentPanel" class="booking-selection-modal">
      <div class="booking-selection-modal-card">
        <div class="booking-selection-modal-heading">預約</div>
        <div class="booking-selection-modal-body">
          <fieldset class="service-picker-fieldset"><legend>可選預約項目</legend><div id="servicePicker"></div></fieldset>
          <fieldset class="selected-service-fieldset"><legend>目前選擇</legend><div id="selectedServiceList"></div></fieldset>
          <div id="selectionSummary" class="hidden"></div>
          <div id="formMessage" class="hidden"></div>
          <input id="bookingDate" value="">
          <div class="fixture-tail" aria-hidden="true"></div>
        </div>
      </div>
    </section>
  </body></html>`);
  await page.addStyleTag({ content: read('booking/group-booking.css') });
  await page.addStyleTag({ content: `
    body { margin: 0; font-family: system-ui, sans-serif; }
    #appointmentPanel { width: min(100%, 390px); margin: 0 auto; }
    .booking-selection-modal-heading { padding: 20px; height: 48px; }
    .booking-selection-modal-body { height: 280px; overflow-y: auto; padding: 12px; border: 1px solid #bbb; }
    .service-picker-fieldset { min-height: 280px; }
    .fixture-tail { height: 550px; }
    .hidden { display: none; }
  ` });
  await page.evaluate(() => {
    window.BookingServiceTypeColor = { slot: () => 0 };
    if (!window.crypto.randomUUID) {
      window.crypto.randomUUID = () => '50000000-0000-4000-8000-000000000001';
    }
    window.BookingSystem = {
      request: async () => ({
        settings: {}, bookings: [],
        services: [{ serviceId: 'service-1', title: '測試服務', durationMinutes: 40, priceAmount: 800, isActive: true }],
      }),
      clientError: (code, message) => Object.assign(new Error(message), { code }),
    };
    window.fetch = async () => new Response(JSON.stringify({
      ok: true, data: {
        settings: { maxPartySize: 3, primaryTechnicianId: 'tech-1' },
        technicians: [{ technicianId: 'tech-1', name: '主要技師', isActive: true }],
        bookingGroups: {},
      },
    }), { status: 200 });
  });
  await page.addScriptTag({ content: read('booking/group-booking.js') });
  await page.evaluate(async () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    await BookingSystem.request(
      { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' },
      'member', 'fixture-token', 'user.booking.bootstrap',
    );
    const party = document.querySelector('#bookingPartySize');
    party.value = '2';
    party.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const first = page.locator('.participant-card[data-participant-index="0"]');
  const second = page.locator('.participant-card[data-participant-index="1"]');
  const warning = second.locator('.participant-item-warning');
  await expect(first).toHaveAttribute('open', '');
  await expect(second).not.toHaveAttribute('open', '');
  await expect(warning).toBeHidden();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('booking:selection-changed', {
    detail: { items: [{ serviceId: 'service-1', quantity: 1 }] },
  })));
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText('還未選擇預約項目');
  expect(await warning.evaluate((element) => getComputedStyle(element).fontSize)).not.toBe('16px');
  expect(await warning.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(156, 61, 49)');

  const container = page.locator('.booking-selection-modal-body');
  const summary = second.locator('summary');
  await page.evaluate(() => {
    const container = document.querySelector('.booking-selection-modal-body');
    const summary = document.querySelector('.participant-card[data-participant-index="1"] > summary');
    const bounds = container.getBoundingClientRect();
    container.scrollTop += summary.getBoundingClientRect().top - (bounds.bottom - 55);
  });
  const before = await summary.evaluate((element) => {
    const parent = document.querySelector('.booking-selection-modal-body');
    return element.getBoundingClientRect().top - parent.getBoundingClientRect().top;
  });
  expect(before).toBeGreaterThan(140);

  // Native click without Playwright's automatic pre-click scrolling.
  await summary.evaluate((element) => element.click());
  await expect(second).toHaveAttribute('open', '');
  await expect.poll(async () => summary.evaluate((element) => {
    const parent = document.querySelector('.booking-selection-modal-body');
    return Math.round(element.getBoundingClientRect().top - parent.getBoundingClientRect().top);
  })).toBeLessThan(20);
  const technician = second.locator('.participant-technician-field');
  const fieldBox = await technician.boundingBox();
  const containerBox = await container.boundingBox();
  expect(fieldBox.y).toBeGreaterThanOrEqual(containerBox.y);
  expect(fieldBox.y).toBeLessThan(containerBox.y + containerBox.height);

  await second.locator('.service-add-button').evaluate((button) => button.click());
  await expect(second.locator('.participant-item-warning')).toBeHidden();
  expect(errors).toEqual([]);
});
