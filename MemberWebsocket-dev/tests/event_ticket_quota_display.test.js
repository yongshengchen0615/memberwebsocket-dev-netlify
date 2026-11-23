const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('event tickets distinguish unlimited distribution from redemption usage caps', () => {
  const html = read('admin/index.html');
  const adminApp = read('admin/app.js');
  const eventApp = read('event/app.js');
  const api = read('supabase/functions/api/index.ts');
  const component = read('event-ticket-ui.js');

  assert.ok(html.includes('使用數量上限（0 代表不限量）<input id="eventTicketQuota"'));
  assert.ok(html.includes('發放張數不設上限'));
  assert.ok(adminApp.includes('使用數量上限必須是 0–1,000,000 的整數。'));
  assert.ok(adminApp.includes('已發放 ${Number(ticket.claimedCount || 0)} 張 · 已使用 ${Number(ticket.usedCount || 0)} / 上限 ${Number(ticket.quota)} 次'));
  assert.ok(adminApp.includes('使用不限量（已使用 ${Number(ticket.usedCount || 0)} 次）'));

  assert.ok(component.includes("options.fixed ? '發放方式' : '使用數量上限'"));
  assert.ok(component.includes('quota - used'));
  assert.ok(eventApp.includes('function eventTicketQuotaText(ticket)'));
  assert.ok(eventApp.includes('剩餘 ${Math.max(0, quota - usedCount)} 次'));
  assert.ok(eventApp.includes('使用數量上限：${eventTicketQuotaText(ticket)}'));
  assert.ok(eventApp.includes('活動使用名額已額滿'));

  assert.ok(api.includes('quota: Number(row.quota || 0)'));
  assert.ok(api.includes('claimedCount,'));
  assert.ok(api.includes('usedCount,'));
  assert.ok(api.includes('event_ticket_used_counts'));
  assert.ok(api.includes('&& !soldOut &&'));
  assert.ok(api.includes('使用數量上限必須是 0–1,000,000。'));
});
