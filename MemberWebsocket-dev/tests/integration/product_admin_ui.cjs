const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const {fixture}=require('./platform-fixture.cjs');
const root=path.resolve(__dirname,'../..');
async function waitFor(check){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,15));}assert.ok(check(),'UI did not reach expected state');}
async function page(h,merchant=true){
 const errors=[],calls=[];const dom=new JSDOM(fs.readFileSync(path.join(root,merchant?'admin/workspace.html':'platform/index.html'),'utf8'),{url:'https://allowed.test/'+(merchant?'admin/workspace.html':'platform/'),runScripts:'outside-only'});
 const w=dom.window;w.AbortController=AbortController;w.AbortSignal=AbortSignal;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.liff={init:async({liffId})=>{calls.push(liffId);},isLoggedIn:()=>true,isInClient:()=>true,getIDToken:()=>merchant?'manager':'root'};
 w.sessionStorage.setItem('platform-line-login-return-v1',String(Date.now()));
 w.fetch=async(url,options)=>{
  if(String(url).includes('config.json'))return new Response(fs.readFileSync(path.join(root,'config.json'),'utf8'));
  return h.handler(new Request(String(url),{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));
 };
 w.addEventListener('error',e=>errors.push(e.message));
 w.eval(fs.readFileSync(path.join(root,'member-system.js'),'utf8'));
 w.eval(fs.readFileSync(path.join(root,'platform/app.js'),'utf8'));
 await waitFor(()=>merchant?(calls.length===1&&!w.document.querySelector('#applicationForm').hidden&&w.document.querySelector('#platformStatus').textContent.includes('已登入')):!w.document.querySelector('#platformWorkspace').hidden);
 return {dom,w,d:w.document,errors,calls};
}
test('AC-017/018 DOM + real handler/SQL: admin applies, root checks only grants, admin saves each approved LINE page',async()=>{
 const h=await fixture();let admin,platform;try{
  admin=await page(h);const d=admin.d;
  assert.deepEqual(admin.calls,['2010791619-vhevCvvD']);
  // Verified LINE login reads status only; explicit submit owns the first write.
  assert.equal((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n,0);
  assert.equal(d.querySelector('#applicationForm').hidden,false);
  const applicationForm=d.querySelector('#applicationForm');
  applicationForm.elements.namedItem('businessName').value='商家管理員';
  applicationForm.elements.namedItem('slug').value='merchant-dom-review';
  applicationForm.dispatchEvent(new admin.w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>!d.querySelector('#applicationProgress').hidden);
  assert.match(d.querySelector('#applicationProgress').textContent,/等待總管理員審核/);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='APPLICATION_SUBMITTED'")).rows[0].n,1);
  assert.match(d.querySelector('#onboardingJourney')?.textContent||'',/送出申請/);
  assert.match(d.querySelector('#applicationNextStep')?.textContent||'',/總管理員/);
  assert.equal(d.querySelector('#applicationForm').hidden,true);assert.equal(d.querySelector('#merchantWorkspace').hidden,true);
  platform=await page(h,false);const p=platform.d;
  assert.match(p.querySelector('#applicationList').textContent,/商家管理員/);
  p.querySelector('#applicationList button').click();
  p.querySelector('[data-approve-feature="membership"]').checked=true;
  p.querySelector('#approvalForm').dispatchEvent(new platform.w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>p.querySelectorAll('#tenantList .tenant-card').length===1);
  assert.equal((await h.db.query('select credentials_configured from platform_private.tenants')).rows[0].credentials_configured,false);
  d.querySelector('#refreshApplication').click();await waitFor(()=>!d.querySelector('#merchantWorkspace').hidden);
  assert.match(d.querySelector('#merchantSetupGuide')?.textContent||'',/LINE Developers/);
  assert.match(d.querySelector('#merchantSetupGuide').textContent,/Basic settings/);
  assert.equal(d.querySelector('#merchantLaunchStatus').dataset.ready,'false');
  assert.equal(d.querySelector('#merchantOverviewPanel').hidden,false);
  assert.equal(d.querySelector('#merchantLineSettingsPanel').hidden,true);
  assert.equal(d.querySelector('#merchantLineSettingsTab').hidden,false);
  d.querySelector('#merchantLineSettingsTab').click();
  assert.equal(d.querySelector('#merchantLineSettingsPanel').hidden,false);
  assert.equal(d.querySelector('#merchantOverviewPanel').hidden,true);
  assert.equal(d.querySelectorAll('#merchantFeatureNav [data-line-feature]').length,2);
  assert.equal(d.querySelector('#merchantFeatureNav [data-line-feature="booking"]'),null);
  d.querySelector('#merchantOverviewTab').click();
  assert.equal(d.querySelector('#merchantLineSettingsPanel').hidden,true);
  d.querySelector('#merchantLineSettingsTab').click();
  const form=d.querySelector('#merchantLineForm');
  for(const name of ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId'])form.elements.namedItem(name).value=h.tenant.line[name];
  for(const [name,value]of Object.entries(h.tenant.credentials))form.elements.namedItem(name).value=value;
  form.dispatchEvent(new admin.w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>d.querySelector('#merchantMessage').textContent.includes('已安全儲存'));
  assert.equal(form.elements.namedItem('channelAccessToken').value,'');
  d.querySelector('[data-line-feature="membership"]').click();
  form.elements.namedItem('memberLiffId').value=h.tenant.line.memberLiffId;
  form.dispatchEvent(new admin.w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>d.querySelector('#merchantMessage').textContent.includes('已安全儲存'));
  const row=(await h.db.query('select line_config,features,version from platform_private.tenants')).rows[0];
  assert.equal(row.line_config.memberLiffId,h.tenant.line.memberLiffId);assert.equal(row.features.booking,false);assert.equal(row.version,3);
  assert.match(d.querySelector('#merchantLaunchStatus').textContent,/平台/);
  assert.match(d.querySelector('#merchantMessage').textContent,/尚未開放/);
  assert.deepEqual(admin.errors,[]);assert.deepEqual(platform.errors,[]);
 }finally{admin?.dom.window.close();platform?.dom.window.close();await h.db.close();}
});
