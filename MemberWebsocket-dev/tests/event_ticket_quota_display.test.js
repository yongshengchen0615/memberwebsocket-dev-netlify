const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('event ticket quota is presented as limited quantity in admin and member UI', () => {
  const adminHtml = read('admin/index.html');
  const adminApp = read('admin/app.js');
  const eventApp = read('event/app.js');
  const api = read('supabase/functions/api/index.ts');

  assert.ok(adminHtml.includes('<label>限量張數<input id="eventTicketQuota"'));
  assert.doesNotMatch(adminHtml, /總發放上限/);
  assert.ok(adminApp.includes('限量張數必須是 0–1,000,000 的整數。'));
  assert.ok(adminApp.includes('已領取 ${Number(ticket.claimedCount || 0)} / 限量 ${Number(ticket.quota)} 張'));

  assert.ok(read('event-ticket-ui.js').includes("options.fixed ? '發放方式' : '限量張數'"));
  assert.ok(eventApp.includes('function eventTicketQuotaText(ticket)'));
  assert.ok(eventApp.includes('剩餘 ${Math.max(0, quota - claimedCount)} 張'));
  assert.ok(eventApp.includes('限量張數：${eventTicketQuotaText(ticket)}'));
  assert.ok(api.includes('quota: Number(row.quota || 0)'));
  assert.ok(api.includes('claimedCount,'));
  assert.ok(api.includes('限量張數必須是 0–1,000,000。'));
});
