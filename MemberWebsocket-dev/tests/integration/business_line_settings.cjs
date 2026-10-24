const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const fixture=require('./business-platform-fixture.cjs');
const owner='U'+'2'.repeat(32),features={membership:true,points:true,events:false,calendar:false,booking:false,integrations:false,testing:false,usage:false};
const line={adminChannelId:'2010791619',memberChannelId:'2010787602',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin',memberLiffId:'2010787602-member',pointsLiffId:'',eventLiffId:'',calendarLiffId:'',bookingLiffId:''};
const credentials={channelAccessToken:'synthetic-access-token-123456789',channelSecret:'a'.repeat(32)};
const until=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.ok(check(),'UI never reached expected state');};
test('AC-302/303/304: LINE settings tab owns module forms, isolated saves, module credentials and scoped links',async()=>{
 const h=await fixture();let dom;try{
  const t=await h.approve(owner,'inline-shop',features);
  dom=new JSDOM('<section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div><section id="membersPanel"></section><section id="cardsPanel"></section><section id="eventsPanel"></section>',{url:'https://allowed.test/admin/?business=inline-shop',runScripts:'outside-only'});
  const w=dom.window;w.AbortSignal=AbortSignal;
  w.MemberAdminSession={get:()=>({config:{business:t.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'},idToken:'manager'})};
  let loseFirstSave=true;const calls=[];w.fetch=async(url,options)=>{const input=JSON.parse(options.body);calls.push(input);const response=await h.handler(new Request(url,{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));if(input.action==='platform.line.save'&&loseFirstSave){loseFirstSave=false;throw Error('synthetic lost response after committed SQL');}return response;};
  w.eval(fs.readFileSync(path.join(__dirname,'../../admin/business-line-settings.js'),'utf8'));
  await w.BusinessLineSettings.apply({features,business:{slug:t.slug}});
  const d=w.document;await until(()=>d.querySelectorAll('[data-business-line-feature]').length===2);
  assert.equal(d.querySelector('[data-business-line-feature="events"]'),null);
  assert.equal(d.querySelectorAll('#businessLineFeatureNav button').length,2);
  assert.equal(d.querySelector('#membersPanel [data-business-line-feature]'),null,'LINE forms must no longer appear inline inside business management');
  assert.equal(d.querySelector('[data-business-line-feature="membership"]').hidden,false);
  assert.equal(d.querySelector('[data-business-line-feature="points"]').hidden,true);
  d.querySelector('#businessLineFeatureTab-points').click();
  assert.equal(d.querySelector('[data-business-line-feature="membership"]').hidden,true);
  assert.equal(d.querySelector('[data-business-line-feature="points"]').hidden,false);
  d.querySelector('#businessLineFeatureTab-membership').click();
  assert.equal(d.querySelector('#businessLineFeatureContent [data-business-line-feature="membership"] [data-feature-client]').getAttribute('href'),'https://allowed.test/member/?business=inline-shop');
  assert.equal(d.querySelector('#businessLineFeatureContent [data-business-line-feature="points"] [data-feature-client]').getAttribute('href'),'https://allowed.test/points/?business=inline-shop');
  const member=d.querySelector('#businessLine-membership'),points=d.querySelector('#businessLine-points');
  const fill=(form,key,value)=>{form.elements.namedItem(key).value=value;form.elements.namedItem(key).dispatchEvent(new w.Event('input',{bubbles:true}));};
  for(const input of d.querySelectorAll('input[pattern]'))assert.doesNotThrow(()=>new RegExp(input.pattern,'v'));
  fill(member,'memberLiffId','2010787602-invalid@');assert.equal(member.elements.memberLiffId.validity.patternMismatch,true);
  fill(points,'pointsLiffId','2010787602-unsaved');
  for(const [key,value]of Object.entries({...line,...credentials}))if(member.elements.namedItem(key))fill(member,key,value);
  member.dispatchEvent(new w.Event('submit',{cancelable:true}));
  await until(()=>d.querySelector('[data-business-line-feature="membership"] [role="status"]').textContent.includes('無法確認'));
  assert.equal(points.querySelector('button[type=submit]').disabled,true);
  member.dispatchEvent(new w.Event('submit',{cancelable:true}));
  await until(()=>d.querySelector('[data-business-line-feature="membership"] [role="status"]').textContent.includes('已儲存'));
  const row=(await h.db.query('select * from platform_private.tenants')).rows[0];
  assert.equal(row.line_config.memberLiffId,line.memberLiffId);assert.equal(row.line_config.pointsLiffId,'');
  assert.equal(calls.filter(c=>c.action==='platform.line.save')[0].requestId,calls.filter(c=>c.action==='platform.line.save')[1].requestId);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MODULE_LINE_UPDATED'")).rows[0].n,1);
  assert.equal(points.elements.pointsLiffId.value,'2010787602-unsaved');assert.equal(member.elements.channelAccessToken.value,'');assert.equal(member.elements.channelSecret.value,'');
  assert.equal(d.querySelector('#businessLineIdentity-membership').hidden,true,'shared Login identity must disappear after initial setup');
  assert.equal(d.querySelector('#businessLineIdentity-points').hidden,true,'other modules must not repeat business Login inputs');
  assert.equal(points.elements.adminChannelId.disabled,true,'shared Login identity must not be editable from another feature');
  fill(points,'channelAccessToken','synthetic-points-token-123456789');fill(points,'channelSecret','b'.repeat(32));
  points.dispatchEvent(new w.Event('submit',{cancelable:true}));
  await until(()=>d.querySelector('[data-business-line-feature="points"] [role="status"]').textContent.includes('已儲存'));
  const saved=(await h.db.query('select module_line from platform_private.tenants')).rows[0].module_line;
  assert.equal(saved.membership.line.memberLiffId,line.memberLiffId);assert.equal(saved.points.line.pointsLiffId,'2010787602-unsaved');
  assert.equal(calls.filter(c=>c.action==='platform.line.save').at(-1).credentials.channelAccessToken,'synthetic-points-token-123456789');
  await w.BusinessLineSettings.apply({features:{...features,membership:false},business:{slug:t.slug}});
  assert.equal(d.querySelector('[data-business-line-feature="membership"]'),null);
  assert.equal(d.querySelector('#businessLineFeatureTab-membership'),null);
  assert.equal(d.querySelectorAll('#businessLineFeatureNav button').length,1);
  assert.equal(d.querySelector('[data-business-line-feature="points"]').hidden,false);
 }finally{dom?.window.close();await h.db.close();}
});
test('AC-303/305: real handler + SQL reject revoked, cross-business, cross-module and stale writes',async()=>{
 const h=await fixture();try{
  const t=await h.approve(owner,'scoped-shop',features),other=await h.approve('U'+'3'.repeat(32),'other-shop',features);
  const save=(body={})=>h.call({action:'platform.line.save',business:t.slug,feature:'membership',expectedVersion:1,requestId:crypto.randomUUID(),line,credentials,...body},'manager');
  assert.equal((await save({business:other.slug})).status,403);
  assert.equal((await save({feature:'events'})).body.error.code,'FEATURE_DISABLED');
  assert.equal((await save({line:{...line,pointsLiffId:'2010787602-forged'}})).body.error.code,'LINE_FEATURE_SCOPE');
  assert.equal((await save()).status,200);
  assert.equal((await save()).body.error.code,'PLATFORM_CONFLICT');
  let current=(await h.call({action:'platform.application.bootstrap',business:t.slug},'manager')).body.data.tenant;
  await h.call({action:'platform.tenant.features.save',tenantId:t.id,features:{...features,membership:false},expectedVersion:current.version,requestId:crypto.randomUUID()});
  assert.equal((await save({expectedVersion:current.version+1})).body.error.code,'FEATURE_DISABLED');
  const rows=(await h.db.query('select slug,line_config from platform_private.tenants order by slug')).rows;
  assert.deepEqual(rows.find(r=>r.slug==='other-shop').line_config,other.line_config);
 }finally{await h.db.close();}
});
test('AC-306: scoped settings use the database Channel, never a caller-selected Channel or business',async()=>{
 const h=await fixture();try{
  const t=await h.approve(owner,'channel-shop',{...features,points:false});
  const updated={...line,adminChannelId:'2099999999',adminLiffId:'2099999999-admin'};
  const saved=await h.call({action:'platform.line.save',feature:'membership',expectedVersion:1,requestId:crypto.randomUUID(),line:updated,credentials},'manager');
  assert.equal(saved.status,200);assert.equal(saved.body.data.tenant.moduleLine.membership.credentialsConfigured,true);
  const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');
  let selected;
  const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:new Set(),verifyApplicantIdentity:async(_token,channel)=>{selected=channel;return{lineUserId:owner};},verifyIdentity:()=>assert.fail('root verifier must not be used')});
  const response=await handler(new Request('https://backend.test',{method:'POST',body:JSON.stringify({action:'platform.application.bootstrap',idToken:'synthetic',business:t.slug,adminChannelId:'attacker-selected'})}));
  assert.equal(response.status,200);assert.equal(selected,'2099999999');
 }finally{await h.db.close();}
});
test('AC-303: late-mounted modules immediately inherit current grants and settings integration',async()=>{
 const dom=new JSDOM('<main id="adminView"><nav class="surface-nav"></nav></main>',{url:'https://allowed.test/admin/?business=late-shop',runScripts:'outside-only'});
 try{
  const w=dom.window,d=w.document;let mounted=0;w.BusinessLineSettings={apply:()=>mounted++};
  w.eval(fs.readFileSync(path.join(__dirname,'../../admin/business-workspace.js'),'utf8'));
  w.BusinessWorkspace.apply({features:{points:true},business:{name:'Late fixture'}});
  d.querySelector('.surface-nav').insertAdjacentHTML('beforeend','<button id="bookingTab"></button><button id="cardsTab"></button>');
  d.querySelector('#adminView').insertAdjacentHTML('beforeend','<section id="bookingPanel"></section><section id="cardsPanel"></section>');
  await until(()=>d.querySelector('#bookingTab').hidden);
  assert.equal(d.querySelector('#bookingPanel').hidden,true);assert.equal(d.querySelector('#cardsTab').hidden,false);assert.equal(d.querySelector('#cardsPanel').hidden,false);
  assert.ok(mounted>1,'late modules must also receive inline settings');
 }finally{dom.window.close();}
});

test('AC-307: approved feature-specific LINE settings do not require unrelated notification purposes',async()=>{
 const h=await fixture();let dom;
 try {
  const scoped={membership:false,points:false,events:false,calendar:true,booking:true,integrations:true,testing:true,usage:true};
  const t=await h.approve(owner,'per-feature-shop',scoped);
  dom=new JSDOM('<section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div>',{url:'https://allowed.test/admin/?business=per-feature-shop',runScripts:'outside-only'});
  const w=dom.window;w.AbortSignal=AbortSignal;
  w.MemberAdminSession={get:()=>({config:{business:t.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'},idToken:'manager'})};
  w.fetch=(url,options)=>h.handler(new Request(url,{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));
  w.eval(fs.readFileSync(path.join(__dirname,'../../admin/business-line-settings.js'),'utf8'));
  await w.BusinessLineSettings.apply({features:scoped,business:{slug:t.slug}});
  const d=w.document;await until(()=>d.querySelectorAll('[data-business-line-feature]').length===2);
  assert.deepEqual([...d.querySelectorAll('[data-business-line-feature]')].map(el=>el.dataset.businessLineFeature),['calendar','booking']);
  assert.ok(d.querySelector('#businessLine-calendar [name=calendarLiffId]'));
  assert.ok(d.querySelector('#businessLine-booking [name=bookingLiffId]'));
  assert.equal(d.querySelector('#businessLine-calendar [name=bookingLiffId]'),null);
  assert.equal(d.querySelector('#businessLine-booking [name=calendarLiffId]'),null);
  assert.equal(d.querySelector('#notification-calendar-member'),null,'calendar has no active automatic push');
  assert.equal(d.querySelectorAll('[id^=notification-booking-]').length,2,'booking has admin and member notification purposes');
  assert.equal(d.querySelector('[data-business-line-feature="integrations"]'),null);
  assert.equal(d.querySelector('[data-business-line-feature="testing"]'),null);
  assert.equal(d.querySelector('[data-business-line-feature="usage"]'),null);
  assert.equal(d.querySelector('#businessLineIdentity-booking').hidden,false,'first-time shared Login identity remains configurable');
 } finally {dom?.window.close();await h.db.close();}
});
test('AC-308: utility-only merchants cannot open an empty LINE settings tab',()=>{
 const dom=new JSDOM('<main id="adminView"><nav class="surface-nav"><button id="lineSettingsTab"></button></nav><section id="lineSettingsPanel"></section></main>',{url:'https://allowed.test/admin/',runScripts:'outside-only'});
 try{
  const w=dom.window,d=w.document;
  w.eval(fs.readFileSync(path.join(__dirname,'../../admin/business-workspace.js'),'utf8'));
  w.BusinessWorkspace.apply({features:{membership:false,points:false,events:false,calendar:false,booking:false,integrations:true,testing:true,usage:true},business:{name:'Tools only'}});
  assert.equal(d.querySelector('#lineSettingsTab').hidden,true);
  assert.equal(d.querySelector('#lineSettingsTab').disabled,true);
  assert.equal(d.querySelector('#lineSettingsPanel').hidden,true);
 }finally{dom.window.close();}
});
