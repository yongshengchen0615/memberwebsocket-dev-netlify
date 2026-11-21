const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
const values={pageTitle:'門市櫃檯',conflictStartMin:540,conflictStartMax:1080,conflictDurationMin:20,conflictDurationMax:240};
test('AC-FD-CONFLICT-005/006: merchant may save page title and bounds without resubmitting LINE credentials',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');
 const calls=[],args={actor:'U'+'2'.repeat(32),issuedAt:new Date('2026-11-21T10:00:00Z'),tenant:{id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}},db:{rpc:async(name,body)=>{calls.push({name,body});return{data:{frontdesk:{...values},version:7,staff:[]},error:null};}}};
 const body={action:'platform.frontdesk.preferences.save',requestId:'10000000-0000-4000-8000-000000000008',expectedVersion:6,preferences:values};
 const result=await frontdeskAdmin({...args,body});
 assert.equal(result.version,7);
 assert.equal(calls.length,1,'separate policy action never calls LINE credential verification');
 assert.equal(calls[0].name,'platform_frontdesk_admin');
 assert.equal(calls[0].body.p_action,'preferences.save');
 assert.deepEqual(calls[0].body.p_body.preferences,values);
 assert.match(calls[0].body.p_body.payloadHash,/^[a-f0-9]{64}$/);
 for(const p of [
  {...values,conflictStartMin:1090},
  {...values,conflictDurationMax:15},
  {...values,conflictStartMin:545},
  {...values,conflictDurationMin:0},
  {...values,pageTitle:'x'.repeat(61)},
  {...values,pageTitle:'hello\nworld'}
 ]) {
  await assert.rejects(()=>frontdeskAdmin({...args,body:{...body,requestId:'10000000-0000-4000-8000-000000000009',preferences:p}}),/櫃檯頁面抬頭或衝突預約/);
 }
 assert.equal(calls.length,1,'invalid policies must not reach the database');
});
test('AC-FD-CONFLICT-001/007: paired read is staff-authorized, tenant-scoped and does not expose public RPC execution',()=>{
 const sql=read('supabase/migrations/20261121224500_frontdesk_conflict_history_policy.sql');
 const ui=read('frontdesk/app.js'),edge=read('supabase/functions/_shared/frontdesk-handler.mjs');
 assert.match(edge,/\['frontdesk\.history','history'\]/);
 assert.match(sql,/if s\.id is null or s\.status<>'approved' or s\.permission_mode<>'review'/);
 assert.match(sql,/if p_action='history' then/);
 assert.match(sql,/actor_line_user_id=\$2/);
 assert.match(sql,/platform_private\.frontdesk_paired_phone_source/);
 assert.match(sql,/totalDurationMinutes',b\.total_duration_minutes/);
 assert.match(ui,/櫃檯新增的衝突預約/);
 assert.match(ui,/原預約資料/);
 assert.doesNotMatch(sql,/grant execute on function public\.platform_frontdesk_request[^;]+to anon/i);
});
test('AC-FD-CONFLICT-004/006: database independently rejects values outside 10-minute merchant policy',()=>{
 const sql=read('supabase/migrations/20261121224500_frontdesk_conflict_history_policy.sql');
 const ui=read('frontdesk/app.js');
 for(const rule of [
  "v_clock%10<>0", "p_duration%10<>0", "FRONTDESK_CONFLICT_POLICY",
  "v_policy->>'conflictStartMin'","v_policy->>'conflictStartMax'",
  "v_policy->>'conflictDurationMin'","v_policy->>'conflictDurationMax'"
 ])assert.ok(sql.includes(rule),rule);
 assert.match(ui,/time=node\('select'\)/);
 assert.match(ui,/duration=node\('select'\)/);
 assert.match(ui,/for\(let m=startMin;m<=startMax;m\+=10\)/);
 assert.match(ui,/for\(let m=durationMin;m<=durationMax;m\+=10\)/);
 assert.match(read('admin/frontdesk-settings.js'),/platform\.frontdesk\.preferences\.save/);
});
