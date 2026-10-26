const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const fixture=require('./business-platform-fixture.cjs'),root=path.resolve(__dirname,'../..');
const owner='U'+'2'.repeat(32),features={membership:true,points:false,events:false,calendar:false,booking:true,integrations:false,testing:false,usage:false};
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,15));}assert.ok(check(),'UI did not reach expected state');};
const fill=(w,form,name,value)=>{const input=form.elements.namedItem(name);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));};
async function setup(){
 const h=await fixture(),tenant=await h.approve(owner,'simple-line',features),calls=[];
 const dom=new JSDOM('<section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div>',{url:'https://allowed.test/admin/?business='+tenant.slug,runScripts:'outside-only'}),w=dom.window;
 w.AbortSignal=AbortSignal;w.MemberAdminSession={get:()=>({idToken:'manager',config:{business:tenant.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'}})};
 w.fetch=(url,options)=>{calls.push(JSON.parse(options.body));return h.handler(new Request(url,{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));};
 w.eval(fs.readFileSync(path.join(root,'admin/business-line-settings.js'),'utf8'));await w.BusinessLineSettings.apply({features});
 return{h,tenant,w,d:w.document,calls,close:async()=>{w.close();await h.db.close();}};
}

test('simple entry saves exact LIFF URL using real handler/SQL without separately entering Login Channel or Messaging credentials',async()=>{
 const t=await setup();try{
  const form=t.d.querySelector('#businessLine-membership');
  fill(t.w,form,'adminLiffId','2010791619-admin');fill(t.w,form,'memberLiffId','https://liff.line.me/2010787602-member');
  assert.equal(form.checkValidity(),true,'LIFF input derives matching Login IDs; Messaging is optional');
  form.dispatchEvent(new t.w.Event('submit',{cancelable:true}));await until(()=>t.d.querySelector('[data-business-line-feature=membership] > [role=status]').textContent.includes('已儲存'));
  const save=t.calls.find(c=>c.action==='platform.line.save');assert.equal(save.feature,'membership');assert.equal(save.line.memberLiffId,'2010787602-member');assert.equal(save.line.memberChannelId,'2010787602');assert.equal(save.line.adminChannelId,'2010791619');assert.deepEqual(save.credentials,{channelAccessToken:'',channelSecret:''});
  const entry=await t.h.call({action:'platform.business.public',business:t.tenant.slug,feature:'membership'});assert.equal(entry.status,200);assert.equal(entry.body.data.line.memberLiffId,'2010787602-member');
  assert.equal(t.d.querySelector('#businessLineIdentity-membership').hidden,true);assert.equal((await t.h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,0);
  assert.equal(t.d.querySelector('[data-feature-client=membership]').search,'?business=simple-line');
 }finally{await t.close();}
});

test('misleading LIFF URLs and a manually mismatched Channel cannot be saved; invalid collapsed account details open and focus',async()=>{
 const t=await setup();try{
  const form=t.d.querySelector('#businessLine-membership');fill(t.w,form,'adminLiffId','2010791619-admin');
  for(const value of ['https://liff.line.me.evil.test/2010787602-member','https://liff.line.me/2010787602-member?x=1','https://liff.line.me/2010787602-member#x','http://liff.line.me/2010787602-member']){
   fill(t.w,form,'memberLiffId',value);assert.equal(form.checkValidity(),false);form.dispatchEvent(new t.w.Event('submit',{cancelable:true}));
  }
  fill(t.w,form,'memberLiffId','2010787602-member');fill(t.w,form,'memberChannelId','2099999999');
  const details=form.elements.memberChannelId.closest('details');assert.ok(details,'technical Login Channel lives under account details');details.open=false;
  form.dispatchEvent(new t.w.Event('submit',{cancelable:true}));assert.equal(details.open,true);assert.equal(t.d.activeElement,form.elements.memberChannelId);assert.equal(t.calls.filter(c=>c.action==='platform.line.save').length,0);
 }finally{await t.close();}
});

test('scoped adapter clears all secret drafts/pending state and rejects late responses after mounting another merchant',async()=>{
 const dom=new JSDOM('<main id="mount"><nav data-line-feature-nav></nav><div data-line-feature-content></div></main>',{url:'https://allowed.test/admin/workspace.html?business=a-shop',runScripts:'outside-only'}),w=dom.window;
 try{
  w.eval(fs.readFileSync(path.join(root,'admin/business-line-settings.js'),'utf8'));
  assert.equal(typeof w.BusinessLineSettings.mount,'function','the real merchant shell can provide an authenticated scoped adapter');
  const tenant=slug=>({id:slug,slug,version:1,status:'active',features:{booking:true},line:{adminChannelId:'2010791619',adminLiffId:'2010791619-admin'},moduleLine:{}});
  let release;const delayed=new Promise(resolve=>release=resolve),mount=w.document.querySelector('#mount');
  w.BusinessLineSettings.mount({root:mount,data:{tenant:tenant('a-shop')},request:async()=>delayed});
  const old=mount.querySelector('form'),secret=old.elements.channelSecret;fill(w,old,'channelSecret','a'.repeat(32));
  const route=mount.querySelector('#merchant-notification-booking-admin');assert.ok(route);fill(w,route,'channelAccessToken','unsaved-private-token');
  const statusButton=[...mount.querySelectorAll('button')].find(b=>b.textContent==='讀取 Webhook 狀態');statusButton.click();
  w.BusinessLineSettings.clear();assert.equal(secret.value,'');assert.equal(route.elements.channelAccessToken.value,'');
  w.BusinessLineSettings.mount({root:mount,data:{tenant:tenant('b-shop')},request:async()=>({})});
  release({endpoint:'https://a-shop.example.test/receiver',apiState:'accepted',configurationState:'configured'});
  await new Promise(r=>setImmediate(r));assert.equal(mount.textContent.includes('a-shop.example.test'),false);assert.equal(mount.querySelector('[data-line-webhook] input').value,'');assert.equal(mount.querySelector('[data-feature-client]').search,'?business=b-shop');assert.equal(mount.querySelector('button[type=submit]').disabled,false);
 }finally{w.close();}
});

test('saving another feature preserves the draft LIFF and its automatically derived Login Channel together',async()=>{
 const t=await setup();try{
  const member=t.d.querySelector('#businessLine-membership'),booking=t.d.querySelector('#businessLine-booking');
  fill(t.w,member,'adminLiffId','2010791619-admin');fill(t.w,member,'memberLiffId','2010787602-member');
  fill(t.w,booking,'bookingLiffId','2099999999-booking');
  member.dispatchEvent(new t.w.Event('submit',{cancelable:true}));await until(()=>t.d.querySelector('[data-business-line-feature=membership] > [role=status]').textContent.includes('已儲存'));
  assert.equal(booking.elements.bookingLiffId.value,'2099999999-booking');assert.equal(booking.elements.memberChannelId.value,'2099999999');
  assert.equal(booking.checkValidity(),true);booking.dispatchEvent(new t.w.Event('submit',{cancelable:true}));await until(()=>t.d.querySelector('[data-business-line-feature=booking] > [role=status]').textContent.includes('已儲存'));
  const saved=(await t.h.db.query('select module_line from platform_private.tenants')).rows[0].module_line;
  assert.equal(saved.membership.line.memberChannelId,'2010787602');assert.equal(saved.booking.line.memberChannelId,'2099999999');
 }finally{await t.close();}
});
