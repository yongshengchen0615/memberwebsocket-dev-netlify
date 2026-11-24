const {test}=require('node:test');
const assert=require('node:assert/strict');
const custom={"id":"custom_12345678-1234-4123-8123-123456789abc","label":"設備維護","requiresConflictTime":false,"memberDescription":"設備維護，請改期。","enabled":true};
function rejects(fn,message){try{fn();return false;}catch(error){return error instanceof TypeError&&error.message===message;}}
test('Issue #425: rejection policy contract',async(t)=>{
 const {defaultRejectionSettings,normalizeRejectionSettings,validateRejectionSettingsUpdate,resolveRejectionReason}=await import('../supabase/functions/_shared/frontdesk-rejection-settings.mjs');
 const cases=[
 ["legacy defaults preserve both routes",()=>{let cfg=defaultRejectionSettings();return resolveRejectionReason(cfg,"technician_leave","booking.update").requiresConflictTime===false&&resolveRejectionReason(cfg,"unrecorded_phone_booking","booking.reject_phone").requiresConflictTime===true;}],
 ["custom reason and title normalize independently",()=>{let cfg=defaultRejectionSettings();cfg.dropdownTitle="  請選原因  ";cfg.reasons.push({...custom});let next=validateRejectionSettingsUpdate(defaultRejectionSettings(),cfg);return next.dropdownTitle==="請選原因"&&resolveRejectionReason(next,custom.id,"booking.update").memberDescription===custom.memberDescription;}],
 ["blank title falls back",()=>{let cfg=defaultRejectionSettings();cfg.dropdownTitle=" ";return normalizeRejectionSettings(cfg).dropdownTitle==="請選擇拒絕原因";}],
 ["reason snapshots are detached",()=>{let cfg=defaultRejectionSettings();cfg.reasons.push({...custom});let snapshot=resolveRejectionReason(cfg,custom.id,"booking.update");cfg.reasons[2].memberDescription="新版文字";return snapshot.memberDescription===custom.memberDescription;}],
 ["default settings are independent",()=>{let cfg=defaultRejectionSettings();cfg.reasons[0].label="改名";return defaultRejectionSettings().reasons[0].label!=="改名";}],
 ["conflict route cannot be bypassed",()=>{let cfg=defaultRejectionSettings();cfg.reasons.push({...custom,requiresConflictTime:true});return rejects(()=>resolveRejectionReason(cfg,custom.id,"booking.update"),"REJECTION_ROUTE_MISMATCH");}],
 ["ordinary reason cannot create a paired booking",()=>rejects(()=>resolveRejectionReason(defaultRejectionSettings(),"technician_leave","booking.reject_phone"),"REJECTION_ROUTE_MISMATCH")],
 ["legacy disabled reasons become usable; forged IDs rejected",()=>{let cfg=defaultRejectionSettings();cfg.reasons.push({...custom,enabled:false});return normalizeRejectionSettings(cfg).reasons[2].enabled===true&&resolveRejectionReason(cfg,custom.id,"booking.update").id===custom.id&&rejects(()=>resolveRejectionReason(cfg,"forged","booking.update"),"BOOKING_REJECTION_REASON_REQUIRED");}],
 ["removing old or final reason works; history snapshots remain detached",()=>{let original=defaultRejectionSettings(),snapshot=resolveRejectionReason(original,"technician_leave","booking.update");let cfg=defaultRejectionSettings();cfg.reasons.pop();let one=validateRejectionSettingsUpdate(original,cfg);let empty=validateRejectionSettingsUpdate(one,{dropdownTitle:"無理由",reasons:[]});return one.reasons.length===1&&empty.reasons.length===0&&snapshot.memberDescription===original.reasons[0].memberDescription;}],
 ["invalid enabled type, duplicate IDs and duplicate legacy labels rejected",()=>{let cfg=defaultRejectionSettings();return rejects(()=>normalizeRejectionSettings({...cfg,reasons:[{...custom,enabled:"true"}]}),"INVALID_REJECTION_REASON")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[custom,custom]}),"INVALID_REJECTION_REASON")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[cfg.reasons[0],{...cfg.reasons[1],label:cfg.reasons[0].label,enabled:false}]}),"DUPLICATE_REJECTION_LABEL");}],
 ["malformed text and duplicate active labels rejected",()=>{let cfg=defaultRejectionSettings();return rejects(()=>normalizeRejectionSettings({...cfg,dropdownTitle:"a\nb"}),"INVALID_REJECTION_TITLE")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[{...custom,memberDescription:"x".repeat(401)}]}),"INVALID_REJECTION_DESCRIPTION")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[...cfg.reasons,{...custom,label:cfg.reasons[0].label}]}),"DUPLICATE_REJECTION_LABEL");}],
 ["unknown fields rejected rather than trusted",()=>rejects(()=>normalizeRejectionSettings({...defaultRejectionSettings(),tenantId:"other"}),"INVALID_REJECTION_SETTINGS")],
 ["legacy reason without vacation field defaults to false",()=>{let cfg=defaultRejectionSettings();delete cfg.reasons[0].hasVacationTechnicians;return normalizeRejectionSettings(cfg).reasons[0].hasVacationTechnicians===false;}],
 ["vacation option is independent per reason and normalized",()=>{let cfg=defaultRejectionSettings();cfg.reasons[1].hasVacationTechnicians=true;return normalizeRejectionSettings(cfg).reasons[1].hasVacationTechnicians===true&&normalizeRejectionSettings(cfg).reasons[0].hasVacationTechnicians===false;}],
 ["vacation option rejects non-boolean values and unknown fields",()=>{let cfg=defaultRejectionSettings();return rejects(()=>normalizeRejectionSettings({...cfg,reasons:[{...cfg.reasons[0],hasVacationTechnicians:'true'},cfg.reasons[1]]}),"INVALID_REJECTION_REASON")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[{...cfg.reasons[0],vacationTechnicianNames:['forged']},cfg.reasons[1]]}),"INVALID_REJECTION_REASON");}]
 ];
 for(const [name,run] of cases)await t.test(name,()=>assert.equal(run(),true));
});

test('Issue #425: admin policy save is validated, versioned and tenant-scoped before RPC',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');
 const {defaultRejectionSettings}=await import('../supabase/functions/_shared/frontdesk-rejection-settings.mjs');
 const calls=[],tenant={id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}};
 const args={db:{rpc:async(name,input)=>{calls.push({name,input});return {data:{version:8},error:null};}},
  actor:'U'+'a'.repeat(32),issuedAt:'2026-11-24T03:00:00Z',tenant};
 const body={action:'platform.frontdesk.rejection-settings.save',expectedVersion:7,
  requestId:'10000000-0000-4000-8000-000000000009',rejectionSettings:defaultRejectionSettings()};
 assert.equal((await frontdeskAdmin({...args,body})).version,8);
 assert.equal(calls.length,1);
 assert.equal(calls[0].name,'platform_frontdesk_admin');
 assert.equal(calls[0].input.p_tenant_id,tenant.id);
 assert.equal(calls[0].input.p_action,'rejection-settings.save');
 assert.equal(calls[0].input.p_body.expectedVersion,7);
 assert.match(calls[0].input.p_body.payloadHash,/^[a-f0-9]{64}$/);
 assert.equal((await frontdeskAdmin({...args,body:{...body,rejectionSettings:{dropdownTitle:'x',reasons:[]}}})).version,8,'empty saved list intentionally disables new rejections');
 await assert.rejects(()=>frontdeskAdmin({...args,body:{...body,rejectionSettings:{dropdownTitle:'x',reasons:[{id:'forged'}]}}}));
 await assert.rejects(()=>frontdeskAdmin({...args,tenant:{...tenant,features:{frontdesk:false,booking:true}},body}));
 assert.equal(calls.length,2);
});


test('AC-003/004/007: all rejected writes use the authorized, tenant-scoped SQL policy wrapper',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const id='custom_12345678-1234-4123-8123-123456789abc';
 const tenant='10000000-0000-4000-8000-000000000001';
 const booking='10000000-0000-4000-8000-000000000011';
 const calls=[],context={id:tenant,slug:'test-shop',name:'測試商家',frontdesk:{loginChannelId:'2010999999',enabled:true}};
 const db={rpc:async(name,args)=>{
  calls.push({name,args});
  return {data:name==='consume_api_rate_limit'?true:name==='platform_frontdesk_context'?context:{booking:{status:'rejected'}},error:null};
 }};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://frontdesk.test']),
  verifyIdentity:async()=>({lineUserId:'U'+'4'.repeat(32),issuedAtMs:Date.now()})});
 const call=async input=>{
  const request=new Request('https://frontdesk.test',{method:'POST',headers:{Origin:'https://frontdesk.test'},
   body:JSON.stringify({business:'test-shop',idToken:'synthetic',...input})});
  const response=await handler(request);return {status:response.status,body:await response.json()};
 };
 const baseline={bookingId:booking,expectedUpdatedAt:'2026-11-24T01:00:00Z',status:'rejected',rejectionReason:id};
 const simple=await call({action:'frontdesk.booking.update',...baseline,requestId:'10000000-0000-4000-8000-000000000012'});
 assert.equal(simple.status,200);
 let writes=calls.filter(x=>x.name==='platform_frontdesk_rejection_request');
 assert.equal(writes.length,1);
 assert.equal(writes[0].args.p_tenant_id,tenant);
 assert.equal(writes[0].args.p_action,'booking.update');
 assert.equal(writes[0].args.p_body.rejectionReason,id);
 assert.equal(writes[0].args.p_actor,'U'+'4'.repeat(32));
 const paired=await call({action:'frontdesk.booking.reject-phone',...baseline,
  requestId:'10000000-0000-4000-8000-000000000013',
  phoneRequestId:'PHONE-10000000-0000-4000-8000-000000000014',startTime:'11:00',totalDurationMinutes:60});
 assert.equal(paired.status,200);
 writes=calls.filter(x=>x.name==='platform_frontdesk_rejection_request');
 assert.equal(writes.length,2);
 assert.equal(writes[1].args.p_action,'booking.reject_phone');
 assert.equal(writes[1].args.p_body.rejectionReason,id);
 assert.equal(writes[1].args.p_body.items,undefined);
 const vacationId='10000000-0000-4000-8000-0000000000a1';
 const withVacation=await call({action:'frontdesk.booking.update',...baseline,
  requestId:'10000000-0000-4000-8000-000000000019',
  vacationTechnicianIds:[vacationId]});
 assert.equal(withVacation.status,200);
 writes=calls.filter(x=>x.name==='platform_frontdesk_rejection_request');
 assert.deepEqual(writes.at(-1).args.p_body.vacationTechnicianIds,[vacationId]);
 const before=calls.length;
 for(const invalid of [[vacationId,vacationId],['00000000-0000-0000-0000-000000000000'],['forged'],Array(11).fill(vacationId),'a']){
  const response=await call({action:'frontdesk.booking.update',...baseline,
   requestId:'10000000-0000-4000-8000-000000000018',vacationTechnicianIds:invalid});
  assert.equal(response.status,400);
 }
 assert.equal(calls.length,before,'malformed technician IDs must not reach rate-limits or SQL');
 const forged=await call({action:'frontdesk.booking.update',...baseline,
  rejectionReason:'__proto__',requestId:'10000000-0000-4000-8000-000000000015'});
 assert.equal(forged.status,400);
 assert.equal(calls.length,before,'malformed IDs must not reach rate-limits or SQL');
 const confirmation=await call({action:'frontdesk.booking.update',...baseline,status:'confirmed',
  requestId:'10000000-0000-4000-8000-000000000016'});
 assert.equal(confirmation.status,400,'confirmation cannot smuggle a rejection reason');
});
test('AC-001/002/006/008: SQL migration preserves legacy provenance and hides rejection policies from anonymous users',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const sql=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261124120000_frontdesk_configurable_rejection.sql'),'utf8');
 assert.match(sql,/rejection_reason_id=\$6,rejection_reason_label=\$7,rejection_member_description=\$8/);
 assert.match(sql,/v_mapped:=case when v_paired then 'unrecorded_phone_booking' else 'technician_leave'/);
 assert.match(sql,/v_reason:=coalesce\(nullif\(NEW\.rejection_reason_label/);
 assert.match(sql,/v_reason:=coalesce\(v_reason,'拒絕預約'\)/);
 assert.match(sql,/FRONTDESK_REJECTION_INSTALLER_CONTRACT_CHANGED/);
 assert.match(sql,/FRONTDESK_BOOKINGS_RESPONSE_CHANGED/);
 assert.match(sql,/platform_private\.validate_frontdesk_rejection_settings/);
 assert.match(sql,/p_action='rejection-settings.save'/);
 assert.match(sql,/platform_private\.frontdesk_rejection_defaults/);
 assert.match(sql,/ - ''rejectionSettings''/,'public LINE config must not expose staff policy');
 assert.match(sql,/revoke all on function public\.platform_frontdesk_rejection_request[\s\S]*?from public,anon,authenticated/);
 assert.match(sql,/grant execute on function public\.platform_frontdesk_rejection_request[\s\S]*?to service_role/);
});


test('AC-FD-REJ-TABS-001/002: rejection policy is a separately labelled, authenticated tab',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
 const admin=read('admin/frontdesk-settings.js');
 const css=read('admin/frontdesk-settings/frontdesk-settings-page.css');
 assert.match(admin,/\['rejectionSettings', '拒絕預約設定'\]/);
 assert.match(admin,/rejectionPanel\.id = 'frontdesk-rejection-panel'/);
 assert.match(admin,/rejectionPanel\.setAttribute\('role', 'tabpanel'\)/);
 assert.match(admin,/rejectionPanel\.setAttribute\('aria-labelledby', 'frontdesk-tab-rejectionSettings'\)/);
 assert.match(admin,/tabButtons\.get\('rejectionSettings'\)\.hidden = !hasRejectionSettings/);
 assert.match(admin,/if \(!hasRejectionSettings && selectedTab === 'rejectionSettings'\) selectTab\('line'\)/);
 assert.match(admin,/rejectionPanel\.append\(settings\)/);
 assert.doesNotMatch(admin,/content\.append\(settings\)/);
 assert.match(admin,/historyKeys\.has\(selectedTab\) \? loadHistory\(\) : Promise\.resolve\(\)/);
 assert.match(css,/\.frontdesk-rejection-list/);
 assert.match(css,/@media\(max-width:650px\)/);
});
test('AC-VAC-001..008: independent manager option, staff selector, SQL validation and no arbitrary description',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
 const ui=read('frontdesk/app.js'),admin=read('admin/frontdesk-settings.js');
 const css=read('frontdesk/styles.css'),sql=read('supabase/migrations/20261124134500_frontdesk_vacation_technicians.sql');
 assert.match(admin,/check\('需要設定衝突時間並登記現場預約', 'requiresConflictTime'\),\s*check\('有休假技師（櫃檯端可勾選已設定的技師）', 'hasVacationTechnicians'\)/);
 assert.match(admin,/hasVacationTechnicians:reason\.hasVacationTechnicians===true/);
 assert.match(ui,/vacationPanel\.hidden=!hasVacation/);
 assert.match(ui,/vacationTechnicianIds:vacationIds/);
 assert.match(ui,/booking\.vacationTechnicians/);
 assert.doesNotMatch(ui,/vacationQuick|vacationCheck/,'no legacy free-floating checkbox');
 assert.doesNotMatch(ui,/rejectionMemberDescription\s*:/,'member copy must be resolved by server');
 assert.match(css,/frontdesk-vacation-options/);
 assert.match(sql,/platform_private\.frontdesk_active_technicians\(t\.runtime_schema\)/);
 assert.match(sql,/join %I\.booking_technicians t on t\.id=s\.id::uuid and t\.is_active=true/);
 assert.match(sql,/VACATION_TECHNICIANS_REQUIRED/);
 assert.match(sql,/VACATION_TECHNICIANS_NOT_ENABLED/);
 const bookingOnly=read('supabase/migrations/20261124162000_frontdesk_booking_only_vacation_candidates.sql');
 assert.match(bookingOnly,/booking_participants bp/);
 assert.match(bookingOnly,/bt\.id is distinct from bs\.primary_technician_id/);
 assert.match(bookingOnly,/frontdesk_booked_vacation_names/);
 assert.match(sql,/cardinality\(v_names\)<>cardinality\(v_ids\)/);
 assert.match(sql,/rejectionMemberDescription',v_description/);
 assert.match(sql,/v_payload:=p_body\|\|jsonb_build_object/);
 assert.match(sql,/revoke all on function public\.platform_frontdesk_rejection_request[\s\S]*?from public,anon,authenticated/);
 assert.match(sql,/grant execute on function public\.platform_frontdesk_rejection_request[\s\S]*?to service_role/);
});
