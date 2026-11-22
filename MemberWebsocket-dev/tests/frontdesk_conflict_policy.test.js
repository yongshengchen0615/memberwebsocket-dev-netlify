const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
const values={pageTitle:'門市櫃檯'};
test('AC-WALKIN-WINDOW-004: merchant may save only page title without LINE credentials or conflict limits',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');
 const calls=[],args={actor:'U'+'2'.repeat(32),issuedAt:new Date('2026-11-21T10:00:00Z'),tenant:{id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}},db:{rpc:async(name,body)=>{calls.push({name,body});return{data:{frontdesk:{...values},version:7,staff:[]},error:null};}}};
 const body={action:'platform.frontdesk.preferences.save',requestId:'10000000-0000-4000-8000-000000000008',expectedVersion:6,preferences:values};
 const result=await frontdeskAdmin({...args,body});
 assert.equal(result.version,7);
 assert.equal(calls.length,1,'title preferences do not verify LINE credentials');
 assert.equal(calls[0].name,'platform_frontdesk_admin');
 assert.deepEqual(calls[0].body.p_body.preferences,values);
 assert.match(calls[0].body.p_body.payloadHash,/^[a-f0-9]{64}$/);
 const malicious={...values,conflictStartMin:1000,conflictStartMax:1100,conflictDurationMin:700,conflictDurationMax:710};
 await frontdeskAdmin({...args,body:{...body,requestId:'10000000-0000-4000-8000-000000000010',preferences:malicious}});
 assert.deepEqual(calls[1].body.p_body.preferences,values,'legacy bounds are ignored even if forged in an API request');
 for(const p of [{pageTitle:'x'.repeat(61)},{pageTitle:'hello'+String.fromCharCode(10)+'world'},{pageTitle:null}]){
  await assert.rejects(()=>frontdeskAdmin({...args,body:{...body,requestId:'10000000-0000-4000-8000-000000000009',preferences:p}}),/櫃檯頁面抬頭不正確/);
 }
 assert.equal(calls.length,2,'invalid titles must not reach the database');
});
test('AC-FD-CONFLICT-001/007: paired read is staff-authorized, tenant-scoped and does not expose public RPC execution',()=>{
 const sql=read('supabase/migrations/20261121224500_frontdesk_conflict_history_policy.sql');
 const ui=read('frontdesk/app.js'),edge=read('supabase/functions/_shared/frontdesk-handler.mjs');
 assert.match(edge,/\['frontdesk\.history','history'\]/);
 assert.match(sql,/if s\.id is null or s\.status<>'approved' or s\.permission_mode<>'review'/);
 assert.match(sql,/if p_action='history' then/);
 assert.match(sql,/actor_line_user_id=\$2/);
 // Audit pairing must survive a replacement changing from confirmed to completed
 // or cancelled; live status-filtered helper deliberately cannot do this.
 const history=sql.split("if p_action='history' then")[1].split("if p_action='bookings' then")[0];
 assert.match(history,/BOOKING_PHONE_CREATED/);
 assert.match(history,/BOOKING_REJECTED/);
 assert.match(history,/paired.created_at=e.created_at/);
 assert.match(history,/p.admin_note='原預約 '/);
 assert.match(history,/p.booking_date=b.booking_date/);
 assert.doesNotMatch(history,/and p.status\s+in|and p.status\s*=|frontdesk_paired_phone_source\(\$1/);
 assert.match(sql,/totalDurationMinutes',b\.total_duration_minutes/);
 assert.match(ui,/櫃檯新增的衝突預約/);
 assert.match(ui,/原預約資料/);
 assert.doesNotMatch(sql,/grant execute on function public\.platform_frontdesk_request[^;]+to anon/i);
});

test('AC-FD-LINE-001/002/004: LINE single-order history is scoped before pagination and still actor-bound',()=>{
 const sql=read('supabase/migrations/20261122133000_frontdesk_history_booking_scope.sql');
 const edge=read('supabase/functions/_shared/frontdesk-handler.mjs');
 const ui=read('frontdesk/app.js');
 const history=sql.split("if p_action='history' then")[1].split("if p_action='bookings' then")[0];
 assert.ok(history,'SQL history branch must exist');
 assert.match(history,/bid:=nullif\(p_body->>'bookingId',''\)::uuid/);
 assert.match(history,/actor_line_user_id=\$2[\s\S]*and \(\$3::uuid is null or target_id=\$3::text\)/);
 assert.match(history,/and \(\$3::uuid is null or target_id=\$3::text\)[\s\S]*order by id desc limit 30/);
 assert.match(history,/using t\.runtime_schema,p_actor,bid/);
 assert.match(sql,/s\.permission_mode<>'review'/);
 assert.match(edge,/\['frontdesk\.bookings','frontdesk\.history'\]\.includes\(body\.action\)/);
 assert.match(ui,/request\('frontdesk\.history',bookingId\?\{bookingId\}:\{\}\)/);
 assert.match(ui,/records\.filter\(record=>String\(record\?\.booking\?\.id/);
 assert.match(ui,/本筆預約處理紀錄/);
 assert.doesNotMatch(sql,/grant execute on function public\.platform_frontdesk_request[^;]+to anon/i);
});

test('AC-WALKIN-WINDOW-001..006: both UIs use inclusive original window and SQL ignores legacy bounds',()=>{
 const migration=read('supabase/migrations/20261122163500_walkin_original_window_inclusive.sql');
 const frontdesk=read('frontdesk/app.js');
 const admin=read('admin/booking-panel-core.js');
 const edge=read('supabase/functions/_shared/frontdesk-handler.mjs');
 const manager=read('supabase/functions/_shared/frontdesk-admin.mjs');
 const settings=read('admin/frontdesk-settings.js');
 assert.match(frontdesk,/Math\.ceil\(originalStartMin\/10\)\*10;m<=originalEndMin;m\+=10/);
 assert.match(admin,/Math\.ceil\(originalStart\/10\)\*10;value<=originalEnd;value\+=10/);
 assert.match(frontdesk,/candidateStart>=originalStartMin&&candidateStart<=originalEndMin/);
 assert.match(admin,/candidate >= originalStart && candidate <= originalEnd/);
 assert.match(frontdesk,/for\(let m=10;m<=1430;m\+=10\)/);
 assert.match(admin,/for\(let value=10;value<=1430;value\+=10\)/);
 for(const key of ['conflictStartMin','conflictStartMax','conflictDurationMin','conflictDurationMax']){
  assert.ok(!frontdesk.includes('frontdeskPolicy.'+key),'frontdesk cannot use configured '+key);
  assert.ok(!admin.includes('bound(\''+key),'admin cannot use configured '+key);
  assert.ok(!settings.includes("dropdown('"+key),'merchant settings cannot expose '+key);
 }
 assert.match(settings,/preferences: \{ pageTitle: pageTitle\.input\.value\.trim\(\) \}/);
 assert.match(manager,/input\.preferences=\{pageTitle:title\.trim\(\)\}/);
 assert.match(edge,/FRONTDESK_NOT_OVERLAPPING/);
 assert.match(migration,/v_old_bounds/);
 assert.match(migration,/v_new_bounds/);
 assert.match(migration,/booking_slot_fits/);
 assert.match(migration,/'\(v_settings->>''slot_interval_minutes''\)::integer','5'/,'paired walk-in ignores normal booking cadence only, not work hours');
 assert.match(migration,/v_candidate > /);
 assert.match(migration,/v_candidate < /);
 assert.match(migration,/ <= \$3::timestamp \+ make_interval/);
 assert.match(migration,/ >= \$3::timestamp/);
 assert.match(migration,/pref:=jsonb_build_object\('pageTitle'/);
 assert.match(migration,/WALKIN_FRONTDESK_ROUTER_CONTRACT_CHANGED/);
});
test('AC-WALKIN-WINDOW-003: outside-window starts are blocked at UI and database boundary',()=>{
 const ui=read('frontdesk/app.js'),edge=read('supabase/functions/_shared/frontdesk-handler.mjs');
 assert.match(ui,/const hasConflict=/,'browser must compare two actual time intervals');
 assert.match(ui,/hasConflict\(\)/,'submission must re-check overlap after changes');
 assert.match(ui,/原預約時間區間/,'staff sees an explicit window warning');
 assert.match(edge,/FRONTDESK_NOT_OVERLAPPING/,'server must translate conflict guard errors');
 const sql=read('supabase/migrations/20261122150000_frontdesk_overlap_guard.sql');
 assert.match(sql,/FRONTDESK_NOT_OVERLAPPING/);
 assert.match(sql,/make_interval\(mins=>/,'persisted booking start/end are compared to the requested duration');
 assert.match(sql,/booking_slot_start_at/,'overnight tenant slots must use canonical start timestamps');
 assert.match(sql,/\(b->>'start_at'\)::timestamp/,'compare the persisted original booking instant');
 assert.match(ui,/candidateClock\+1440/,'UI must account for post-midnight business-day clocks');
 assert.match(sql,/FRONTDESK_OVERLAP_ROUTER_CONTRACT_CHANGED/,'migration must fail closed if upstream router changes');
});
