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
 ["disabled or forged reason rejected",()=>{let cfg=defaultRejectionSettings();cfg.reasons.push({...custom,enabled:false});return rejects(()=>resolveRejectionReason(cfg,custom.id,"booking.update"),"BOOKING_REJECTION_REASON_REQUIRED")&&rejects(()=>resolveRejectionReason(cfg,"forged","booking.update"),"BOOKING_REJECTION_REASON_REQUIRED");}],
 ["historical IDs cannot be removed",()=>{let cfg=defaultRejectionSettings();cfg.reasons.pop();return rejects(()=>validateRejectionSettingsUpdate(defaultRejectionSettings(),cfg),"REJECTION_REASON_DELETE_FORBIDDEN");}],
 ["invalid type, duplicate IDs and empty active list rejected",()=>{let cfg=defaultRejectionSettings();return rejects(()=>normalizeRejectionSettings({...cfg,reasons:[{...custom,enabled:"true"}]}),"INVALID_REJECTION_REASON")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[custom,custom]}),"INVALID_REJECTION_REASON")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:cfg.reasons.map(row=>({...row,enabled:false}))}),"REJECTION_REASON_REQUIRED");}],
 ["malformed text and duplicate active labels rejected",()=>{let cfg=defaultRejectionSettings();return rejects(()=>normalizeRejectionSettings({...cfg,dropdownTitle:"a\nb"}),"INVALID_REJECTION_TITLE")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[{...custom,memberDescription:"x".repeat(401)}]}),"INVALID_REJECTION_DESCRIPTION")&&rejects(()=>normalizeRejectionSettings({...cfg,reasons:[...cfg.reasons,{...custom,label:cfg.reasons[0].label}]}),"DUPLICATE_REJECTION_LABEL");}],
 ["unknown fields rejected rather than trusted",()=>rejects(()=>normalizeRejectionSettings({...defaultRejectionSettings(),tenantId:"other"}),"INVALID_REJECTION_SETTINGS")]
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
 await assert.rejects(()=>frontdeskAdmin({...args,body:{...body,rejectionSettings:{dropdownTitle:'x',reasons:[]}}}));
 await assert.rejects(()=>frontdeskAdmin({...args,tenant:{...tenant,features:{frontdesk:false,booking:true}},body}));
 assert.equal(calls.length,1);
});
