const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('event/app.js');
const html = read('event/index.html');
const sql = read('supabase/migrations/20261016213000_sync_unredeemed_event_ticket_metadata.sql');
const api = read('supabase/functions/api/index.ts');
const start = app.indexOf('  function ticketForOffer(offer) {');
const end = app.indexOf('\n  function modalStatusText(', start);
assert.ok(start > 0 && end > start, 'Extract current offer resolver');
const ticketForOffer = vm.runInNewContext('(' + app.slice(start, end).trim() + ')');

for (const ticketType of ['coupon', 'lottery', 'referral', 'membership_join']) {
  test('AC-001: unredeemed ' + ticketType + ' follows edited title, description and terms', () => {
    const ticket = {
      eventTicketId: 'E-123', title: '更新後名稱', ticketType,
      description: '更新後說明', usageMethod: '更新後使用方式',
      usageInstructions: '更新後注意事項', prizes: [{ prizeTitle: '更新後獎品', winRate: 100 }]
    };
    const claim = {
      status: 'available', ticketTitle: '舊名稱', ticketType: 'coupon',
      ticketDescription: '舊說明', usageMethod: '舊方式',
      usageInstructions: '舊規則', prizes: [{ prizeTitle: '舊獎品', winRate: 100 }]
    };
    assert.deepEqual(JSON.parse(JSON.stringify(ticketForOffer({ ticket, claim, history: false }))), ticket);
  });
}
test('AC-002: used ticket keeps its historical title, type, instructions and prizes', () => {
  const ticket = { eventTicketId: 'E-123', title: '現在的名稱', ticketType: 'coupon', prizes: [] };
  const claim = {
    status: 'used', ticketTitle: '使用時名稱', ticketType: 'lottery',
    ticketDescription: '使用時說明', usageMethod: '舊核銷方式',
    usageInstructions: '使用時條件', prizes: [{ prizeTitle: '已抽獎的獎品' }]
  };
  const result = ticketForOffer({ ticket, claim, history: true });
  assert.equal(result.title, claim.ticketTitle);
  assert.equal(result.ticketType, 'lottery');
  assert.equal(result.usageInstructions, claim.usageInstructions);
  assert.equal(result.prizes[0].prizeTitle, '已抽獎的獎品');
});
test('AC-003: missing live ticket safely falls back to claim snapshot', () => {
  const result = ticketForOffer({ ticket: {}, claim: { status: 'available', ticketTitle: '已領取' } });
  assert.equal(result.title, '已領取');
});
test('AC-004: live card and open modal refresh on event realtime, with cache-busted asset', () => {
  assert.match(app, /subscribeRealtime\(state.config, 'event'/);
  assert.match(app, /return loadOffers\(false\)/);
  assert.match(app, /if \(!state.processing && !els.ticketModal.classList.contains\('hidden'\)/);
  assert.match(app, /renderTicketModal\(active\)/);
  assert.match(app, /renderPrizes\(ticket.ticketType, ticket.prizes\)/);
  assert.match(app, /ticketModalDescription.textContent = String\(ticket.description/);
  assert.match(html, /live-ticket-sync-20261016-1/);
});
test('AC-005: SQL updates only unredeemed claims and synchronizes all relevant fields', () => {
  assert.match(sql, /after update of ticket_type,title,description,usage_method,usage_instructions,prizes/);
  assert.match(sql, /c.status = 'claimed'/);
  assert.doesNotMatch(sql, /c.status\s*<>\s*'used'/);
  for (const field of ['ticket_type', 'ticket_title', 'ticket_description', 'usage_method', 'usage_instructions', 'prizes']) {
    assert.match(sql, new RegExp(field + '\\s*='));
  }
  assert.match(sql, /from public.event_tickets as e/);
  assert.match(sql, /notify_fixed_ticket_template_event_change/);
  assert.match(sql, /array\['event'\]::text\[\]/);
  assert.match(api, /if \(claimRow && String\(claimRow.status \|\| ""\) === "used"\) return \[\];/);
});
