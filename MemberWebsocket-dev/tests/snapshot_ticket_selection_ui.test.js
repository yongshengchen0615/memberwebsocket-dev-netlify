const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('snapshot receipt selection has a clear count without advance booking', () => {
  const source = read('booking/booking-receipt.js');
  assert.match(source, /id="snapshotTicketChoices" role="group" aria-label="選擇本次要登記使用的票券"/);
  assert.match(source, /id="snapshotTicketSelectionSummary"[^>]*role="status" aria-live="polite"/);
  assert.match(source, /const selectionSummary = document\.getElementById\('snapshotTicketSelectionSummary'\)/);
  assert.match(source, /checked\.length \+ ' 張票券/);
  assert.match(source, /不需要事先預約/);
  assert.doesNotMatch(source, /id="snapshotTicketBooking"/);
  assert.match(source, /snapshotTicketSelectionSummary'\)\.textContent = '正在確認可登記的票券/);
  assert.match(source, /票券暫時無法載入；可以只送出收據/);
});

test('snapshot ticket cards preserve original choice payload and disabled business rules', () => {
  const source = read('booking/booking-receipt.js');
  assert.match(source, /check\.type = 'checkbox'/);
  assert.match(source, /check\.dataset\.snapshotKind = item\.kind/);
  assert.match(source, /check\.dataset\.snapshotId = item\.selectionId/);
  assert.match(source, /const blocked = item\.selectable !== true/);
  assert.match(source, /check\.disabled = blocked/);
  assert.match(source, /item\.disabledReason/);
  assert.match(source, /label\.classList\.toggle\('is-selected', check\.checked\)/);
  assert.match(source, /status\.textContent = selected \? '已選擇'/);
  assert.match(source, /resetTicketRequest\(\);\s*renderBookings\(\);/);
  assert.match(source, /const selectedBenefits = state\.accessible \? \[\.\.\.document\.querySelectorAll\('\[data-snapshot-id\]:checked'\)\]/);
  assert.doesNotMatch(source, /requestedBookingId/);
  assert.match(source, /user\.booking\.receipt\.prepare/);
  assert.doesNotMatch(source, /item\.title\s*\+\s*'<|innerHTML\s*=\s*item\./);
});

test('snapshot ticket cards respect responsive theme and remain native checkboxes', () => {
  const css = read('booking/booking-receipt.css');
  const html = read('booking/index.html');
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-choice\.is-selected/);
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-choice\.is-unavailable/);
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-choice:focus-within/);
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-checkbox/);
  assert.match(css, /var\(--theme-surface-raised/);
  assert.match(css, /var\(--theme-positive-soft/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(html, /booking-receipt\.css\?v=[^" ]*snapshot-ticket-ui-20261010-1/);
  assert.match(html, /booking-receipt\.js\?v=[^" ]*snapshot-ticket-ui-20261010-1/);
});

test('snapshot renders unclaimed event offers, claims explicitly and never sends unissued event identifiers', () => {
  const receipt = read('booking/booking-receipt.js');
  assert.match(receipt, /item\.selectionId \|\| \(item\.kind === 'event' && item\.claimRequired === true\)/);
  assert.match(receipt, /item\.selectable !== true \|\| item\.claimRequired === true/);
  assert.match(receipt, /snapshot-ticket-claim-button/);
  assert.match(receipt, /BookingSystem\.claimEventTicket\(currentSession\.config, currentSession\.idToken, String\(item\.id \|\| ''\)\)/);
  assert.match(receipt, /await loadSnapshotTickets\(\)/);
  assert.match(receipt, /previouslyChecked\.has\(String\(item\.kind\) \+ ':' \+ String\(item\.selectionId\)\)/);
  assert.match(receipt, /check\.disabled = blocked/);
  assert.match(receipt, /data-snapshot-id\]:checked/);
  const css = read('booking/booking-receipt.css');
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-claim-button/);
});

test('snapshot option cards have an ordered hierarchy, selected state and attached claim footer', () => {
  const source = read('booking/booking-receipt.js');
  const css = read('booking/booking-receipt.css');
  assert.match(source, /heading\.append\(kind, title\)/);
  assert.match(source, /label\.append\(copy, check, indicator\)/);
  assert.match(source, /snapshot-ticket-claim-action/);
  assert.match(source, /option\.classList\.toggle\('is-selected', check\.checked\)/);
  assert.match(source, /selectionSummary\.classList\.toggle\('has-selection', checked\.length > 0\)/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\) 28px/);
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-claim-action/);
  assert.match(css, /#snapshotTicketChoices \.snapshot-ticket-option\.is-unavailable/);
});
test('snapshot overview shows both claimable event tickets and owned tickets without redeeming them', () => {
  const source = read('booking/booking-accessible.js');
  const css = read('booking/booking-accessible.css');
  assert.match(source, /snapshot-overview-ticket/);
  assert.match(source, /snapshot-overview-heading/);
  assert.match(source, /snapshot-overview-status/);
  assert.match(source, /item\.kind === 'event' && item\.claimRequired === true/);
  assert.match(source, /拍攝快照時可先領取/);
  assert.doesNotMatch(source, /BookingSystem\.claimEventTicket/);
  assert.match(css, /\.booking-accessible-tickets \.snapshot-overview-ticket/);
  assert.match(css, /@media \(max-width: 600px\)/);
});

test('snapshot respects member point-card aggregate point budget and admin ticket caps', () => {
  const source = read('booking/booking-receipt.js');
  const api = read('supabase/functions/booking-receipt-api/index.ts');
  assert.match(source,/catalog\.pointTicketMaxPerRedemption/);
  assert.match(source,/catalog\.eventTicketMaxPerDay/);
  assert.match(source,/catalog\.usedTodayCount/);
  assert.match(source,/spent \+ needed > available/);
  assert.match(source,/selectedPoints >= pointLimit/);
  assert.match(source,/usedEventsToday \+ selectedEvents >= eventLimit/);
  assert.match(source,/input\.disabled = fixedBlocked \|\| Boolean\(reason\)/);
  assert.match(source,/pointLimit === 0 \? '不限張數'/);
  assert.match(source,/resetTicketRequest\(\)/);
  assert.match(api,/usedTodayCount:Math\.max\(0,Number\(used\.count\|\|0\)\)/);
  assert.match(api,/\.eq\("member_id",String\(member\.id\)\)\.eq\("status","used"\)/);
});
