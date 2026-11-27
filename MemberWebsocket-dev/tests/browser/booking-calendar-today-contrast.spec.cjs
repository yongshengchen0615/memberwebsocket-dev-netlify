const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const stylesheets = [
  'booking/styles.css',
  'booking/calendar-flow.css',
  'booking/calendar-holiday-theme.css',
  'theme.css',
  'experience.css',
  'booking/booking-mobile.css',
  'booking/booking-accessible.css',
];
const css = stylesheets.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

async function showCalendar(page, theme) {
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
    <body><main id="bookingView" class="app-shell"><div id="calendarGrid" class="calendar-grid">
      <button type="button" class="calendar-day today" data-date="today"><strong class="calendar-day-number">27</strong></button>
      <button type="button" class="calendar-day holiday-disabled" data-date="holiday"><strong class="calendar-day-number">28</strong><span class="calendar-holiday-label">店休</span></button>
      <button type="button" class="calendar-day today holiday-disabled" data-date="both"><strong class="calendar-day-number">27</strong><span class="calendar-holiday-label">店休</span></button>
      <button type="button" class="calendar-day today selected" data-date="selected"><strong class="calendar-day-number">27</strong></button>
    </div><div class="calendar-legend"><span><i class="legend-dot today-dot"></i>今天</span><span><i class="legend-dot holiday-dot"></i>休假日</span></div></main></body></html>`);
}

async function colorInfo(page, marker) {
  return page.locator('[data-date="' + marker + '"]').evaluate(el => {
    const s = getComputedStyle(el);
    const n = getComputedStyle(el.querySelector('.calendar-day-number'));
    const after = getComputedStyle(el, '::after');
    return {
      background: s.backgroundColor,
      border: s.borderTopColor,
      badge: n.backgroundColor,
      badgeText: n.color,
      badgeWidth: el.querySelector('.calendar-day-number').getBoundingClientRect().width,
      innerStyle: after.borderTopStyle,
      innerColor: after.borderTopColor,
      outline: s.outlineStyle,
    };
  });
}

for (const theme of ['light', 'dark']) {
  for (const width of [320, 390, 1280]) {
    test('AC-TODAY-UI: ' + theme + ' calendar keeps today blue and holiday red at ' + width + 'px', async ({ page }) => {
      await page.setViewportSize({ width, height: 840 });
      await showCalendar(page, theme);
      const today = await colorInfo(page, 'today');
      const holiday = await colorInfo(page, 'holiday');
      const both = await colorInfo(page, 'both');
      const selected = await colorInfo(page, 'selected');

      expect(today.background).toBe(theme === 'dark' ? 'rgb(21, 46, 75)' : 'rgb(232, 243, 255)');
      expect(holiday.background).toBe(theme === 'dark' ? 'rgb(66, 35, 30)' : 'rgb(255, 237, 223)');
      expect(today.background).not.toBe(holiday.background);
      expect(today.border).not.toBe(holiday.border);
      expect(today.badge).toBe(theme === 'dark' ? 'rgb(121, 204, 255)' : 'rgb(20, 103, 175)');
      expect(both.background).toBe(holiday.background);
      expect(both.badge).toBe(today.badge);
      expect(both.badgeText).toBe(today.badgeText);
      expect(both.innerStyle).toBe('dashed');
      expect(both.innerColor).toBe(theme === 'dark' ? 'rgb(121, 204, 255)' : 'rgb(20, 103, 175)');
      expect(selected.outline).toBe('solid');

      const dots = await page.locator('.calendar-legend i').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
      expect(dots[0]).toBe(today.badge);
      expect(dots[0]).not.toBe(dots[1]);
      expect(today.badgeWidth).toBeGreaterThanOrEqual(24);
      if (width === 320) {
        const fits = await page.locator('[data-date="today"]').evaluate(el => el.querySelector('.calendar-day-number').getBoundingClientRect().right <= el.getBoundingClientRect().right);
        expect(fits).toBe(true);
      }
    });
  }
}
