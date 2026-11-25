const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'admin/app.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/api/index.ts'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261125093000_retire_calendar_event_bonus.sql'), 'utf8');
const templateSql = fs.readFileSync(path.join(root, 'supabase/migrations/20261125093500_retire_calendar_event_bonus_provisioning.sql'), 'utf8');

test('AC-001: booking holiday settings and existing booking rewards remain available', () => {
  assert.match(admin, /休假日請至「預約」日曆設定/);
  assert.match(app, /openCalendarDateEditor\(date, bookingDate, 'holiday'\)/);
  assert.match(api, /sourceType:"booking"/);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+(?:\S+\.)?(?:point_entries|point_balances|bookings)\b/i);
});

test('AC-002: calendar save and batch endpoints cannot enable bonus points', () => {
  assert.match(api, /admin\.calendar-items\.save"[\s\S]*?bonusPointsEnabled:false,bonusPoints:0[\s\S]*?apply_calendar_batch/);
  assert.match(api, /admin\.calendar-items\.batch"[\s\S]*?bonusPointsEnabled:false,bonusPoints:0[\s\S]*?apply_calendar_batch/);
  assert.doesNotMatch(api, /sourceType:"calendar"/);
});

test('AC-003: migration deactivates offers in legacy and business schemas and prevents reactivation', () => {
  assert.match(sql, /nspname = 'public' OR left\(nspname, 9\) = 'business_'/);
  assert.match(sql, /UPDATE %I\.calendar_items[\s\S]*?bonus_points_enabled = false, bonus_points = 0/);
  assert.match(sql, /ADD CONSTRAINT calendar_items_event_bonus_retired_check[\s\S]*?bonus_points_enabled IS FALSE AND bonus_points = 0/);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
});

test('AC-004: newly provisioned tenant schemas inherit the retirement check', () => {
  assert.match(templateSql, /platform_private\.business_templates/);
  assert.match(templateSql, /business-v1-20261019/);
  assert.match(templateSql, /calendar_items_event_bonus_retired_check/);
  assert.match(templateSql, /pg_get_constraintdef\(k\.oid\)/);
  assert.match(templateSql, /CALENDAR_BONUS_TEMPLATE_CONSTRAINT_DRIFT/);
});

test('AC-005: retired event bonus controls stay absent from the calendar editor', () => {
  for (const id of ['calendarBonusPointsControls', 'calendarBonusPointsEnabled',
    'calendarBonusPointsField', 'calendarBonusPoints']) {
    assert.doesNotMatch(admin, new RegExp('id="' + id + '"'));
    assert.doesNotMatch(app, new RegExp('\\b' + id + '\\b'));
  }
  assert.doesNotMatch(admin, /活動加贈點數|Event bonus/);
  assert.match(admin, /id="calendarItemForm"/);
  assert.match(admin, /id="calendarItemTitle"/);
  assert.match(admin, /id="calendarItemEventLinkFields"/);
});
