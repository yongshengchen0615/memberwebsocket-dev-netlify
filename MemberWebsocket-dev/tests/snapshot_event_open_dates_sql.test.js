const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261013035417_fix_snapshot_event_open_dates_20261013.sql'),'utf8');

test('open-ended event tickets are valid at snapshot review while expired or future tickets remain invalid',()=>{
  assert.match(sql,/e\.starts_on is null or e\.starts_on<=[^\n]+Asia\/Taipei/);
  assert.match(sql,/e\.ends_on is null or e\.ends_on>=[^\n]+Asia\/Taipei/);
  assert.match(sql,/c\.status='claimed' and e\.status='active'/);
  assert.match(sql,/e\.deleted_at is null/);
});

test('snapshot ticket fix retains location proof, ownership, point budgets, and usage caps',()=>{
  assert.match(sql,/t\.member_id=p_member/);
  assert.match(sql,/c\.member_id=p_member/);
  assert.match(sql,/snapshot_ticket_location_proven/);
  assert.match(sql,/POINT_TICKET_INSUFFICIENT_POINTS/);
  assert.match(sql,/EVENT_TICKET_DAILY_LIMIT_REACHED/);
  assert.match(sql,/TICKET_BATCH_LIMIT_EXCEEDED/);
  assert.match(sql,/to service_role/);
});

test('downstream admin registration treats empty tier list as unrestricted, without bypassing a nonempty list',()=>{
  assert.match(sql,/coalesce\(cardinality\(v_event\.allowed_tier_keys\),0\) > 0/);
  assert.match(sql,/not coalesce\(v_tier = any\(v_event\.allowed_tier_keys\),false\)/);
  assert.match(sql,/SNAPSHOT_MIGRATION_EXPECTED_TIER_GUARD_NOT_FOUND/);
});
