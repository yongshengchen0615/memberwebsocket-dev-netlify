const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'..','supabase/migrations/20261012170000_snapshot_ticket_limits_and_point_budget.sql'),'utf8');
test('snapshot selector reserves other bookings before comparing aggregate point spend',()=>{
 assert.match(sql,/s\.status='pending'/);
 assert.match(sql,/budget\.amount>greatest\(0,coalesce\(v_balance,0\)-v_reserved_points\)/);
 assert.match(sql,/POINT_TICKET_INSUFFICIENT_POINTS/);
});
test('snapshot event limit includes already redeemed event claims today',()=>{
 assert.match(sql,/v_used_today\+/);
 assert.match(sql,/c\.status='used'/);
 assert.match(sql,/Asia\/Taipei/);
 assert.match(sql,/EVENT_TICKET_DAILY_LIMIT_REACHED/);
 assert.match(sql,/if v_max_events>0 then/);
 assert.match(sql,/if v_max_points>0/);
});
test('snapshot does not require an advance booking and keeps service-role boundary',()=>{
 assert.match(sql,/if p_booking is not null then/);
 assert.match(sql,/snapshot_ticket_location_proven/);
 assert.doesNotMatch(sql,/ticket_booking_required/);
 assert.match(sql,/revoke all on function public\.validate_snapshot_ticket_selection/);
 assert.match(sql,/to service_role/);
});
