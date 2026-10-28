const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const fixture=require('./business-platform-fixture.cjs'),root=path.resolve(__dirname,'../..'),owner='U'+'2'.repeat(32);
const features={membership:true,points:false,events:false,calendar:false,booking:true,integrations:false,testing:false,usage:false};
const until=async check=>{for(let i=0;i<250;i++){if(check())return;await new Promise(r=>setTimeout(r,15));}assert.ok(check(),'workspace did not reach expected state');};
async function mount(h,tenant){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'admin/workspace.html'),'utf8'),{url:'https://allowed.test/admin/workspace.html?business='+tenant.slug,runScripts:'outside-only'}),w=dom.window,calls=[],errors=[];
 w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.confirm=()=>true;w.structuredClone=structuredClone;
 w.MemberSystem={validateConfig(){}};w.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>true,getIDToken:()=>'manager'};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(url,options)=>{
  if(String(url).includes('config.json'))return Response.json({...JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')),merchantApprovalVersion:2,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api'});
  const input=JSON.parse(options.body);calls.push(input);return h.handler(new Request(String(url),{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));
 };
 w.addEventListener('error',e=>errors.push(e.message));w.eval(fs.readFileSync(path.join(root,'business-context.js'),'utf8'));
 w.eval(fs.readFileSync(path.join(root,'admin/business-line-settings.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'platform/app.js'),'utf8'));
 await until(()=>!w.document.querySelector('#merchantWorkspace').hidden);w.document.querySelector('#merchantLineSettingsTab').click();
 return{dom,w,d:w.document,calls,errors,close:()=>w.close()};
}
const fill=(h,form,name,value)=>{const input=form.elements.namedItem(name);input.value=value;input.dispatchEvent(new h.w.Event('input',{bubbles:true}));};

test('actual selected-merchant workspace saves LIFF-only feature with no shared Messaging prerequisite and exposes purpose/diagnostic controls',async()=>{
 const h=await fixture();let ui;try{
  const tenant=await h.approve(owner,'simple-workspace',features);ui=await mount(h,tenant);
  const form=ui.d.querySelector('#merchantSimpleLine [data-business-line-feature=membership] form');assert.ok(form,'actual merchant settings exposes the same simplified feature renderer');
  assert.equal(ui.d.querySelector('#merchantLineForm').hidden,true);assert.equal(ui.d.querySelector('#merchantLineForm [name=channelAccessToken]').disabled,true);
  fill(ui,form,'adminLiffId','2010791619-admin');fill(ui,form,'memberLiffId','https://liff.line.me/2010787602-member');
  form.dispatchEvent(new ui.w.Event('submit',{cancelable:true}));await until(()=>ui.d.querySelector('#merchantSimpleLine [data-business-line-feature=membership] > [role=status]').textContent.includes('已儲存'));
  const saves=ui.calls.filter(c=>c.action==='platform.line.save');assert.equal(saves.length,1);assert.equal(saves[0].feature,'membership');assert.equal(saves[0].business,tenant.slug);assert.equal(saves[0].idToken,'manager');assert.equal(saves[0].expectedVersion,1);assert.equal(saves[0].credentials.channelAccessToken,'');
  assert.equal(ui.d.querySelector('#merchantSimpleLine [data-feature-client=membership]').search,'?business=simple-workspace');
  assert.ok(ui.d.querySelector('#merchant-notification-booking-admin'));assert.ok(ui.d.querySelector('#merchant-notification-booking-member'));assert.ok(ui.d.querySelector('#merchantSimpleLine [data-line-webhook=booking]'));
  const entry=await h.call({action:'platform.business.public',business:tenant.slug,feature:'membership'});assert.equal(entry.status,200);assert.equal(entry.body.data.line.memberLiffId,'2010787602-member');
  const invalid=await h.call({action:'platform.line.save',business:tenant.slug,feature:'points',line:saves[0].line,credentials:saves[0].credentials,expectedVersion:2,requestId:crypto.randomUUID()},'manager');assert.equal(invalid.status,403);
  assert.deepEqual(ui.errors,[]);
 }finally{ui?.close();await h.db.close();}
});

test('actual merchant workspace clears simplified secret drafts and controls when qualification is revoked',async()=>{
 const h=await fixture();let ui;try{
  const tenant=await h.approve(owner,'simple-revoke',features);ui=await mount(h,tenant);
  const secret=ui.d.querySelector('#merchantSimpleLine [name=channelSecret]');assert.ok(secret);secret.value='a'.repeat(32);secret.dispatchEvent(new ui.w.Event('input',{bubbles:true}));
  await h.db.query("update platform_private.admin_qualifications set status='suspended' where applicant_line_user_id=$1",[owner]);
  ui.d.querySelector('#refreshApplication').click();await until(()=>ui.d.querySelector('#merchantWorkspace').hidden);
  assert.equal(secret.value,'');assert.equal(ui.d.querySelectorAll('#merchantSimpleLine form').length,0);assert.equal(ui.d.querySelector('#merchantLineForm [name=channelAccessToken]').value,'');assert.deepEqual(ui.errors,[]);
 }finally{ui?.close();await h.db.close();}
});
