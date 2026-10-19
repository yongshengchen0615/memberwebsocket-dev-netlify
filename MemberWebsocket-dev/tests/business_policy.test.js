const test=require('node:test'),assert=require('node:assert/strict');
const source=()=>import('../supabase/functions/_shared/business-policy.mjs');
const ctx={status:'active',runtime_schema:'business_'+'a'.repeat(32),features:{membership:true,points:true,events:true,calendar:true,integrations:true,booking:true,testing:true,usage:true}};
test('every endpoint using business data enters the request-scoped authorization adapter',()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'../supabase/functions');
 for(const name of fs.readdirSync(root)){
  const file=path.join(root,name,'index.ts');if(!fs.existsSync(file))continue;
  const text=fs.readFileSync(file,'utf8');
  if(!/import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*['"]\.\.\/_shared\/business-runtime\.ts/.test(text))continue;
  assert.match(text,new RegExp('(?:serveBusiness|businessHandler)\\(\''+name+'\','),name+' must route before its handler reads or writes data');
 }
});
test('AC-202: every approved module accepts its real action and revocation rejects the next request',async()=>{
 const {assertBusinessAction}=await source();
 const actions={membership:'admin.member.update',points:'admin.pointcards.save',events:'admin.event-tickets.save',calendar:'admin.calendar-items.batch',integrations:'admin.integration-overview',booking:'admin.booking.service.save',testing:'admin.test-control.execute',usage:'admin.audit.query'};
 for(const [feature,action]of Object.entries(actions)){
  assert.doesNotThrow(()=>assertBusinessAction(ctx,action));
  assert.throws(()=>assertBusinessAction({...ctx,features:{...ctx.features,[feature]:false}},action),e=>e.code==='FEATURE_DISABLED',feature);
 }
 assert.throws(()=>assertBusinessAction({...ctx,status:'suspended'},'admin.bootstrap'),e=>e.code==='TENANT_SUSPENDED');
 assert.throws(()=>assertBusinessAction({...ctx,runtime_schema:null},'admin.bootstrap'));
 assert.throws(()=>assertBusinessAction(ctx,'admin.future-privileged-command'),e=>e.code==='FEATURE_ACTION_UNMAPPED');
});
test('AC-203: mixed grants check actual points and service-time payloads',async()=>{
 const {assertBusinessAction}=await source();
 assert.throws(()=>assertBusinessAction({...ctx,features:{...ctx.features,membership:false}},'admin.member-grants.add',{serviceTime:{minutes:30}}),e=>e.code==='FEATURE_DISABLED');
 assert.throws(()=>assertBusinessAction({...ctx,features:{...ctx.features,points:false}},'admin.member-grants.add',{points:[{cardId:'id',amount:1}]}),e=>e.code==='FEATURE_DISABLED');
});
test('AC-204: bootstrap does not return unapproved business records',async()=>{
 const {businessBootstrap}=await source();const filtered=businessBootstrap({members:[{phone:'private'}],cards:[{id:'card'}],tickets:[{}],calendarItems:[{}],eventTickets:[{}],stats:{memberCount:4}}, {...ctx,features:{points:true}});
 assert.deepEqual(filtered.members,[]);assert.deepEqual(filtered.calendarItems,[]);assert.deepEqual(filtered.eventTickets,[]);assert.equal(filtered.cards[0].id,'card');assert.doesNotMatch(JSON.stringify(filtered),/private/);
});
