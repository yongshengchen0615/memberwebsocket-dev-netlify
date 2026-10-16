const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('event tickets keep the daily server-enforced redemption limit without the batch toolbar UI', () => {
  const migration = read('supabase/migrations/20261001092726_event_ticket_daily_redemption_limit.sql');
  const admin = read('admin/event-ticket-redemption-limit.js');
  const html = read('event/index.html');
  const today = read('event/today-usable.js');
  const app = read('event/app.js');
  const api = read('supabase/functions/api/index.ts');
  const extension = read('supabase/functions/event-ticket-extension-api/index.ts');
  const todayCss = read('event/today-usable.css');

  assert.match(migration, /max_tickets_per_day/);
  assert.match(migration, /EVENT_TICKET_DAILY_LIMIT_REACHED/);
  assert.match(migration, /at time zone 'Asia\/Taipei'/);
  assert.match(migration, /from public\.members[\s\S]*for update;/);
  assert.match(migration, /used_at >= v_day_start[\s\S]*used_at < v_day_end/);

  assert.match(admin, /每日最多使用活動票券數/);
  assert.match(admin, /maxTicketsPerDay/);
  assert.doesNotMatch(admin, /單次最多使用活動票券數/);

  assert.doesNotMatch(html, /batch-redemption\.css/);
  assert.doesNotMatch(html, /batch-redemption\.js/);
  assert.doesNotMatch(html, /event-batch-toolbar/);
  assert.match(today, /data\.maxTicketsPerDay/);
  assert.match(today, /data\.usedTodayCount/);
  assert.match(today, /每日上限 \$\{maxTicketsLabel\}/);
  assert.doesNotMatch(today, /今日可使用 \$\{usableCount\} 張/);
  assert.match(today, /event:realtime-refresh/);
  assert.match(app, /event:realtime-refresh/);
  assert.match(todayCss, /--md-sys-color-surface-container-high/);
  assert.match(todayCss, /--theme-danger-soft/);

  assert.match(app, /const stateLabel = used \? '已使用'/);
  assert.match(app, /if \(!used \|\| history\) action\.append\(button\)/);
  assert.match(app, /event-ticket:redeemed/);

  assert.match(api, /EVENT_TICKET_DAILY_LIMIT_REACHED/);
  assert.match(api, /claimRow && String\(claimRow\.status \|\| ""\) === "used"/);
  assert.match(extension, /maxTicketsPerDay/);
  assert.match(extension, /max_tickets_per_day/);
  assert.match(extension, /\.upsert\(nextRow, \{ onConflict: "id" \}\)/);
});
