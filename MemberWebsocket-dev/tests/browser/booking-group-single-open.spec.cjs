const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../booking/group-booking.js'), 'utf8');
const start = source.indexOf('  function renderParticipantCards() {');
const end = source.indexOf('\n  function createTechnicianField(', start);
if (start < 0 || end < start) throw new Error('Cannot find the real group booking renderer');
const renderer = source.slice(start, end);

for (const width of [390, 1280]) {
  test(`AC-001/002/003: single participant accordion works in Chromium at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.setContent('<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"></head><body><div id="participantCardList"></div></body></html>');
    await page.addScriptTag({ content: `
      const state = {
        partySize: 3, activeParticipantIndex: 0,
        primaryPicker: document.createElement('fieldset'),
        primarySelected: document.createElement('fieldset'),
      };
      const draft = document.createElement('input');
      draft.id = 'primaryDraft';
      draft.setAttribute('aria-label', '第一位草稿');
      state.primaryPicker.appendChild(draft);
      function participantLabel(index) { return '第' + (index + 1) + '位預約'; }
      function createTechnicianField(index) {
        const label = document.createElement('label');
        label.textContent = '預約技師 ' + (index + 1);
        const input = document.createElement('input');
        input.setAttribute('aria-label', '預約技師 ' + (index + 1));
        label.appendChild(input);
        return label;
      }
      function createExtraServicePicker(index) {
        const fieldset = document.createElement('fieldset');
        fieldset.textContent = '服務項目 ' + (index + 1);
        return fieldset;
      }
      function updateCardSummaries() {}
      function updateSelectionSummary() {}
      ${renderer}
      window.fixture = { state, renderParticipantCards };
      renderParticipantCards();
    ` });

    const cards = page.locator('details.participant-card');
    const opened = page.locator('details.participant-card[open]');
    await expect(cards).toHaveCount(3);
    await expect(opened).toHaveCount(1);
    await expect(cards.nth(0)).toHaveAttribute('open', '');

    await page.locator('#primaryDraft').fill('保留已填資料');
    await cards.nth(1).locator('summary').click();
    await expect(opened).toHaveCount(1);
    await expect(cards.nth(1)).toHaveAttribute('open', '');
    await expect(cards.nth(0)).not.toHaveAttribute('open');

    await cards.nth(2).locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(opened).toHaveCount(1);
    await expect(cards.nth(2)).toHaveAttribute('open', '');

    await cards.nth(0).locator('summary').focus();
    await page.keyboard.press('Space');
    await expect(opened).toHaveCount(1);
    await expect(cards.nth(0)).toHaveAttribute('open', '');
    await expect(page.locator('#primaryDraft')).toHaveValue('保留已填資料');

    await cards.nth(0).locator('summary').click();
    await expect(opened).toHaveCount(1);

    await cards.nth(2).locator('summary').click();
    await page.evaluate(() => {
      window.fixture.state.partySize = 2;
      window.fixture.renderParticipantCards();
    });
    await expect(cards).toHaveCount(2);
    await expect(opened).toHaveCount(1);
    await expect(cards.nth(0)).toHaveAttribute('open', '');
  });
}
