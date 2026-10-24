const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),featureKeys=['membership','points','events','calendar','integrations','booking','testing','usage'];
const features=Object.fromEntries(featureKeys.map(k=>[k,k]));
const qualification=(status='approved',version=2)=>({id:'q-1',status,version,displayName:'Owner',applicantLineUserId:'owner',reviewReason:'補充證明'});
const application=(id,status='approved',overrides={})=>({id,businessName:'商家 '+id,slug:'merchant-'+id,status,version:3,requestedAt:'2026-10-01T00:00:00Z',reviewReason:status==='rejected'?'資料不足':'',tenant:status==='approved'?{id:'tenant-'+id,name:'商家 '+id,slug:'merchant-'+id,status:'active',expired:false,runtimeReady:true,onboarding:{adminReady:true},features:{points:true}}:null,...overrides});
async function settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
async function mount({merchant=true,business='',version=2,q=null,applications=[],qualifications=[],handler,transport,businessContext=false}={}){
 const html=fs.readFileSync(path.join(root,merchant?'admin/workspace.html':'platform/index.html'),'utf8');
 const dom=new JSDOM(html,{url:'https://fixture.test/'+(merchant?'admin/workspace.html':'platform/')+(business?'?business='+business:''),runScripts:'outside-only'}),w=dom.window,calls=[];
 const observers=[],Observer=w.MutationObserver;w.MutationObserver=class extends Observer{constructor(callback){super(callback);observers.push(this);}};
 w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.structuredClone=structuredClone;w.confirm=()=>true;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.MemberSystem={validateConfig(){}};w.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>merchant?'manager':'root'};
 if(business&&!businessContext)w.BusinessContext={configure:async config=>config,slug:business};
 let currentQ=q,currentApps=applications;
 w.fetch=async(url,options)=>{
  if(String(url).includes('config.json'))return{ok:true,json:async()=>({merchantApprovalVersion:version,adminLiffId:'2010791619-admin',platformLiffId:'2012065297-platform',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api'})};
  const input=JSON.parse(options.body);calls.push(input);
  if(transport)return transport(new Request(String(url),{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));
  let result=handler?await handler(input,{q:currentQ,applications:currentApps}):undefined;
  if(result?.throw)throw Error('Network connection lost');
  if(result?.error)return{ok:false,status:result.status||409,json:async()=>({ok:false,error:result.error})};
  if(result===undefined){
   if(input.action==='platform.qualification.bootstrap')result={qualification:currentQ};
   else if(input.action==='platform.qualification.submit'){currentQ=qualification('pending');result={qualification:currentQ};}
   else if(input.action==='platform.merchant.list')result={applications:currentApps};
   else if(input.action==='platform.bootstrap')result={tenants:[],applications:currentApps,features,profile:{displayName:'Root'}};
   else if(input.action==='platform.qualification.list')result={qualifications};
   else if(input.action==='platform.application.bootstrap')result={application:null,tenant:null,features,profile:{displayName:'Owner'}};
   else result={};
  }
  return{ok:true,status:200,json:async()=>({ok:true,data:result})};
 };
 if(businessContext)w.eval(fs.readFileSync(path.join(root,'business-context.js'),'utf8'));
 w.eval(fs.readFileSync(path.join(root,'platform/app.js'),'utf8'));await settle();
 return{dom,w,d:w.document,calls,setQualification(value){currentQ=value;},setApplications(value){currentApps=value;},close(){for(const observer of observers)observer.disconnect();w.close();}};
}
function submit(h,id){h.d.getElementById(id).dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));}

test('v2 account entry reads qualification without creating an application; explicit submit and retry reuse the request ID',async()=>{
 let submissions=0;const h=await mount({handler(input){if(input.action==='platform.qualification.submit'){if(!submissions++)return{throw:true};return{qualification:qualification('pending')};}}});try{
  assert.deepEqual(h.calls.map(x=>x.action),['platform.qualification.bootstrap']);
  assert.equal(h.d.getElementById('qualificationWorkspace').hidden,false);
  h.d.getElementById('submitQualification').click();await settle();
  assert.match(h.d.getElementById('qualificationMessage').textContent,/重試|尚未確認/);
  h.d.getElementById('submitQualification').click();await settle();
  const saves=h.calls.filter(x=>x.action==='platform.qualification.submit');assert.equal(saves.length,2);assert.equal(saves[0].requestId,saves[1].requestId);
  assert.match(h.d.getElementById('qualificationStatus').textContent,/等待|待審/);
  assert.equal(h.calls.some(x=>x.action==='platform.merchant.list'),false);
 }finally{h.close();}
});

test('v2 approved qualification keeps all merchants visible and only ready active cards link to independent workspaces',async()=>{
 const apps=[application('a'),application('b','pending'),application('c','rejected'),application('d'),application('e'),application('f')];
 apps[3].tenant.status='suspended';apps[4].tenant.expired=true;apps[5].tenant.onboarding.adminReady=false;
 const h=await mount({q:qualification(),applications:apps});try{
  assert.deepEqual(h.calls.map(x=>x.action),['platform.qualification.bootstrap','platform.merchant.list']);
  assert.equal(h.d.querySelectorAll('#myMerchantList article').length,6);
  assert.equal(h.d.querySelector('[data-application-id="a"] [data-manage-merchant]').getAttribute('href'),'/admin/?business=merchant-a');
  assert.equal(h.d.querySelector('[data-application-id="a"] [data-merchant-line]').getAttribute('href'),'/admin/workspace.html?business=merchant-a');
  assert.equal(h.d.querySelectorAll('[data-manage-merchant]').length,1);
  assert.match(h.d.querySelector('[data-application-id="c"]').textContent,/資料不足/);
  assert.equal(h.w.location.search,'');assert.equal(h.d.getElementById('merchantWorkspace').hidden,true);
 }finally{h.close();}
});

test('v2 new merchant after A never reuses A; rejected B resubmission carries only B version and preserves uncertain payload',async()=>{
 let lost=true;const h=await mount({q:qualification(),applications:[application('a'),application('b','rejected')],handler(input){if(input.action==='platform.merchant.submit'){if(lost){lost=false;return{throw:true};}return{application:application('b','pending')};}}});try{
  h.d.querySelector('[data-application-id="b"] [data-resubmit-merchant]').click();
  const f=h.d.getElementById('merchantApplicationForm');assert.equal(f.elements.namedItem('slug').value,'merchant-b');
  submit(h,'merchantApplicationForm');await settle();
  const first=h.calls.find(x=>x.action==='platform.merchant.submit');assert.equal(first.applicationId,'b');assert.equal(first.expectedVersion,3);
  assert.equal(f.elements.namedItem('businessName').disabled,true);
  submit(h,'merchantApplicationForm');await settle();
  const saves=h.calls.filter(x=>x.action==='platform.merchant.submit');assert.deepEqual(saves[1],saves[0]);
  h.d.getElementById('newMerchantApplication').click();f.elements.namedItem('businessName').value='商家 C';f.elements.namedItem('slug').value='merchant-c';submit(h,'merchantApplicationForm');await settle();
  const last=h.calls.filter(x=>x.action==='platform.merchant.submit').at(-1);assert.equal(last.applicationId,undefined);assert.equal(last.expectedVersion,undefined);assert.equal(last.slug,'merchant-c');
  assert.equal(h.d.querySelectorAll('#myMerchantList article').length,2);
 }finally{h.close();}
});

test('v2 revoked qualification clears merchant cards and application draft without any automatic submission',async()=>{
 const h=await mount({q:qualification(),applications:[application('a')]});try{
  h.d.querySelector('#merchantApplicationForm [name="businessName"]').value='Private draft';
  h.setQualification(qualification('suspended',3));h.d.getElementById('refreshApplication').click();await settle();
  assert.equal(h.d.getElementById('myMerchantsWorkspace').hidden,true);assert.equal(h.d.getElementById('myMerchantList').childElementCount,0);
  assert.equal(h.d.querySelector('#merchantApplicationForm [name="businessName"]').value,'');assert.match(h.d.getElementById('qualificationStatus').textContent,/停用/);
  assert.equal(h.calls.filter(x=>x.action==='platform.merchant.list').length,1);
  assert.equal(h.calls.some(x=>/submit/.test(x.action)),false);
 }finally{h.close();}
});

test('v2 root separates qualification and merchant decisions with reasons, current versions and exact eight boolean grants',async()=>{
 const h=await mount({merchant:false,qualifications:[qualification('pending',4),{...qualification('suspended',7),id:'q-2'}],applications:[application('b','pending')],handler(input){
  if(input.action==='platform.qualification.review')return{qualification:{...qualification(input.decision,input.expectedVersion+1),id:input.qualificationId}};
  if(input.action==='platform.merchant.review')return{application:application('b',input.decision)};
 }});try{
  assert.ok(h.calls.some(x=>x.action==='platform.bootstrap'));assert.ok(h.calls.some(x=>x.action==='platform.qualification.list'));
  h.d.querySelector('[data-qualification-id="q-1"] [data-review-decision="rejected"]').click();
  h.d.getElementById('reviewReason').value='需要補充證明';submit(h,'v2ReviewForm');await settle();
  const qr=h.calls.find(x=>x.action==='platform.qualification.review');assert.equal(qr.expectedVersion,4);assert.equal(qr.decision,'rejected');assert.equal(qr.reason,'需要補充證明');assert.equal(qr.features,undefined);
  h.d.querySelector('[data-qualification-id="q-2"] [data-review-decision="approved"]').click();submit(h,'v2ReviewForm');await settle();
  assert.equal(h.calls.filter(x=>x.action==='platform.qualification.review').at(-1).expectedVersion,7);
  h.d.querySelector('#applicationList [data-review-decision="approved"]').click();h.d.querySelector('[data-v2-feature="points"]').checked=true;submit(h,'v2ReviewForm');await settle();
  const mr=h.calls.find(x=>x.action==='platform.merchant.review');assert.equal(mr.expectedVersion,3);assert.equal(mr.applicationId,'b');assert.deepEqual(Object.keys(mr.features).sort(),featureKeys.toSorted());assert.equal(mr.features.points,true);assert.ok(Object.values(mr.features).every(v=>typeof v==='boolean'));
  assert.equal(h.calls.some(x=>x.action==='platform.application.approve'),false);
 }finally{h.close();}
});

test('v2 review conflicts refresh rows and close the stale decision; uncertain review locks edits for same request retry',async()=>{
 let count=0;const h=await mount({merchant:false,applications:[application('b','pending')],handler(input){if(input.action==='platform.merchant.review'){count++;return count===1?{throw:true}:{error:{code:'PLATFORM_CONFLICT',message:'版本已更新'}};}}});try{
  h.d.querySelector('#applicationList [data-review-decision="rejected"]').click();h.d.getElementById('reviewReason').value='拒絕原因';submit(h,'v2ReviewForm');await settle();
  assert.equal(h.d.getElementById('reviewReason').disabled,true);submit(h,'v2ReviewForm');await settle();
  const saves=h.calls.filter(x=>x.action==='platform.merchant.review');assert.deepEqual(saves[0],saves[1]);assert.equal(saves[1].features,undefined);
  assert.equal(h.d.getElementById('v2ReviewDialog').open,false);assert.match(h.d.getElementById('platformStatus').textContent,/版本|重新/);
  assert.equal(h.calls.filter(x=>x.action==='platform.bootstrap').length,2);
 }finally{h.close();}
});

test('v2 selected settings only uses selected bootstrap; authorization revocation erases stored LINE fields and secrets',async()=>{
 let denied=false;const tenant={...application('a').tenant,version:1,credentialsConfigured:true,line:{adminChannelId:'2010791619',adminLiffId:'2010791619-private'},onboarding:{adminReady:true,configurationComplete:false,grantedCount:1,commonMissing:[],features:{points:{configured:false,missing:['pointsLiffId']}}}};
 const h=await mount({business:'merchant-a',handler(input){if(input.action==='platform.application.bootstrap')return denied?{status:403,error:{code:'PLATFORM_QUALIFICATION_REQUIRED',message:'管理員資格已停用'}}:{application:application('a'),tenant,features,profile:{displayName:'Owner'}};}});try{
  assert.deepEqual(h.calls.map(x=>x.action),['platform.application.bootstrap']);assert.equal(h.d.getElementById('applicationWorkspace').hidden,true);
  assert.equal(h.d.querySelector('[data-business-switch="true"]').getAttribute('href'),'/admin/');
  h.d.querySelector('#merchantLineForm [name="channelAccessToken"]').value='Private secret';denied=true;h.d.getElementById('refreshApplication').click();await settle();
  assert.equal(h.d.getElementById('merchantWorkspace').hidden,true);assert.ok([...h.d.querySelectorAll('#merchantLineForm input')].every(x=>x.value===''));
 }finally{h.close();}
});

test('v2 selected poll still revokes access while an uncertain LINE save is waiting for retry',async()=>{
 let denied=false;const tenant={...application('a').tenant,version:1,credentialsConfigured:true,line:{adminChannelId:'2010791619',memberChannelId:'2010123456',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin'},onboarding:{adminReady:true,configurationComplete:false,grantedCount:1,commonMissing:[],features:{points:{configured:false,missing:['pointsLiffId']}}}};
 const h=await mount({business:'merchant-a',handler(input){
  if(input.action==='platform.application.bootstrap')return denied?{status:403,error:{code:'PLATFORM_QUALIFICATION_REQUIRED',message:'管理員資格已停用'}}:{application:application('a'),tenant,features,profile:{displayName:'Owner'}};
  if(input.action==='platform.line.save')return{throw:true};
 }});try{
  submit(h,'merchantLineForm');await settle();assert.match(h.d.getElementById('saveMerchantLine').textContent,/重試/);
  denied=true;h.d.getElementById('refreshApplication').click();await settle();
  assert.equal(h.d.getElementById('merchantWorkspace').hidden,true);assert.ok([...h.d.querySelectorAll('#merchantLineForm input')].every(x=>x.value===''));
 }finally{h.close();}
});

test('v2 qualification read failure retains its error and never announces a verified account workspace',async()=>{
 const h=await mount({handler(input){if(input.action==='platform.qualification.bootstrap')return{status:503,error:{code:'RATE_LIMIT_UNAVAILABLE',message:'目前無法確認請求頻率。'}};}});try{
  assert.match(h.d.getElementById('platformStatus').textContent,/無法確認請求頻率/);assert.equal(h.d.getElementById('myMerchantsWorkspace').hidden,true);
 }finally{h.close();}
});

test('v2 DOM with real handler and SQL keeps A approved while B is rejected and resubmitted independently',async()=>{
 const {setup}=require('./fixtures/merchant-http.cjs'),db=await setup();let account,platform;
 try{
  account=await mount({transport:db.handler});assert.equal(await db.count('admin_qualifications'),0);assert.equal(await db.count('applications'),0);
  // PGlite commits are asynchronous beyond the DOM microtask turn.
  const wait=async check=>{const end=Date.now()+5000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check(),account.d.getElementById('platformStatus').textContent+' / '+account.d.getElementById('qualificationMessage').textContent+' / '+JSON.stringify(account.calls));};
  await wait(()=>!account.d.getElementById('qualificationWorkspace').hidden);
  account.d.getElementById('submitQualification').click();
  await wait(()=>account.d.getElementById('qualificationStatus').textContent.includes('等待'));
  platform=await mount({merchant:false,transport:db.handler});await wait(()=>platform.d.querySelector('#qualificationList [data-review-decision="approved"]'));
  platform.d.querySelector('#qualificationList [data-review-decision="approved"]').click();submit(platform,'v2ReviewForm');await wait(()=>!platform.d.getElementById('v2ReviewDialog').open);
  account.d.getElementById('refreshApplication').click();await wait(()=>!account.d.getElementById('myMerchantsWorkspace').hidden);
  const send=async(name,slug)=>{const f=account.d.getElementById('merchantApplicationForm');f.elements.namedItem('businessName').value=name;f.elements.namedItem('slug').value=slug;submit(account,'merchantApplicationForm');await wait(()=>account.d.getElementById('merchantApplicationMessage').textContent.includes('已送出'));};
  await send('Merchant A','real-dom-a');let a=(await db.list())[0];await db.review(a);
  account.d.getElementById('refreshApplication').click();await wait(()=>account.d.querySelector('[data-manage-merchant]'));
  await send('Merchant B','real-dom-b');let b=(await db.list()).find(x=>x.slug==='real-dom-b');await db.review(b,'rejected',null,'補充商家資料');
  account.d.getElementById('refreshApplication').click();await wait(()=>account.d.querySelector('[data-resubmit-merchant]'));
  const rejectedCard=account.d.querySelector('[data-application-id="'+b.id+'"]');assert.match(rejectedCard.textContent,/補充商家資料/);rejectedCard.querySelector('[data-resubmit-merchant]').click();submit(account,'merchantApplicationForm');await wait(()=>account.d.querySelector('[data-application-id="'+b.id+'"]').textContent.includes('等待商家審核'));
  const rows=await db.list();assert.equal(rows.length,2);assert.equal(rows.find(x=>x.id===a.id).status,'approved');assert.equal(rows.find(x=>x.id===b.id).status,'pending');assert.equal(rows.find(x=>x.id===b.id).version,3);assert.equal(await db.count('tenants'),1);
 }finally{account?.close();platform?.close();await db.db.close();}
});

test('v2 qualification rejection shows its reason and requires applicant resubmission before root can approve',async()=>{
 const h=await mount({q:qualification('rejected')});let platform;try{
  assert.match(h.d.getElementById('qualificationReason').textContent,/補充證明/);assert.equal(h.d.getElementById('submitQualification').hidden,false);
  assert.equal(h.calls.some(x=>x.action==='platform.qualification.submit'),false);h.d.getElementById('submitQualification').click();await settle();assert.match(h.d.getElementById('qualificationStatus').textContent,/等待/);
  platform=await mount({merchant:false,qualifications:[qualification('rejected')]});assert.equal(platform.d.querySelector('#qualificationList [data-review-decision]'),null);
 }finally{h.close();platform?.close();}
});

test('v2 selected DOM uses actual BusinessContext, handler and SQL to save only merchant A LINE settings after A/B approval',async()=>{
 const {setup}=require('./fixtures/merchant-http.cjs'),db=await setup();let settings;
 try{
  await db.qualify();let a=await db.submit(db.owner,'real-line-a','Merchant A');a=await db.review(a);let b=await db.submit(db.owner,'real-line-b','Merchant B');await db.review(b,'approved',db.features(['booking']));
  settings=await mount({business:'real-line-a',businessContext:true,transport:db.handler});
  const wait=async check=>{const end=Date.now()+5000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check(),settings.d.getElementById('platformStatus').textContent+' / '+settings.d.getElementById('merchantMessage').textContent);};
  await wait(()=>!settings.d.getElementById('merchantWorkspace').hidden);settings.d.getElementById('merchantLineSettingsTab').click();
  const form=settings.d.getElementById('merchantLineForm');for(const [key,value]of Object.entries({adminChannelId:'2010791619',memberChannelId:'2010123456',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin',channelAccessToken:'synthetic-token-a-00000',channelSecret:'a'.repeat(32)}))form.elements.namedItem(key).value=value;
  submit(settings,'merchantLineForm');await wait(()=>settings.d.getElementById('merchantMessage').textContent.includes('已安全儲存'));
  settings.d.querySelector('[data-line-feature="points"]').click();form.elements.namedItem('pointsLiffId').value='2010123456-points-a';submit(settings,'merchantLineForm');await wait(()=>settings.d.getElementById('merchantMessage').textContent.includes('已安全儲存'));
  const rows=(await db.db.query('select slug,line_config,features from platform_private.tenants order by slug')).rows;assert.equal(rows.length,2);assert.equal(rows[0].line_config.pointsLiffId,'2010123456-points-a');assert.deepEqual(rows[1].line_config,{});assert.equal(rows[1].features.booking,true);
  assert.equal(settings.d.querySelector('[data-business-switch="true"]').getAttribute('href'),'/admin/');assert.equal(settings.calls.some(x=>/^platform\.(qualification|merchant)\./.test(x.action)),false);
 }finally{settings?.close();await db.db.close();}
});
