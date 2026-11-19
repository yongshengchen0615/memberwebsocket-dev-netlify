const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
test('AC-LINE-UX-007: arrow and Home/End keys follow granted modules, keep drafts and focus',async()=>{
 const dom=new JSDOM('<nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div>',{url:'https://fixture.test/admin/?business=synthetic',runScripts:'outside-only'}),w=dom.window;
 try{
  w.AbortSignal=AbortSignal;w.MemberAdminSession={get:()=>({config:{business:'synthetic',supabaseFunctionUrl:'https://fixture.test/functions/v1/api'},idToken:'synthetic'})};
  const features={membership:true,points:true,booking:false};
  w.fetch=async()=>({ok:true,json:async()=>({ok:true,data:{application:{status:'approved'},tenant:{slug:'synthetic',version:1,features,line:{},moduleLine:{}}}})});
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js'),'utf8'));
  await w.BusinessLineSettings.apply({features});
  const d=w.document,first=d.querySelector('#businessLineFeatureTab-membership'),last=d.querySelector('#businessLineFeatureTab-points');
  const draft=d.querySelector('#businessLine-membership input');draft.value='2010123456-draft';draft.dispatchEvent(new w.Event('input',{bubbles:true}));
  first.focus();first.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  assert.equal(d.activeElement,last);assert.equal(last.getAttribute('aria-selected'),'true');assert.equal(first.tabIndex,-1);assert.equal(d.querySelector('#businessLineSection-points').hidden,false);
  last.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));assert.equal(d.activeElement,first);assert.equal(draft.value,'2010123456-draft');
  first.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));assert.equal(d.activeElement,last);
  await w.BusinessLineSettings.apply({features:{membership:true,points:false,booking:false}});
  assert.equal(d.querySelector('#businessLineFeatureTab-points'),null);assert.equal(d.querySelector('#businessLineFeatureTab-booking'),null);
  const remaining=d.querySelector('[role=tab]');remaining.focus();remaining.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));assert.equal(d.activeElement,remaining);assert.equal(remaining.tabIndex,0);
 }finally{w.close();}
});

test('AC-FD-SYNC-003: a strictly newer server version may re-enable approved modules',async()=>{
 const dom=new JSDOM('<nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div>',{
   url:'https://fixture.test/admin/?business=synthetic',runScripts:'outside-only',pretendToBeVisual:true
 }),w=dom.window;
 try{
   w.AbortSignal=AbortSignal;
   w.MemberAdminSession={get:()=>({config:{business:'synthetic',supabaseFunctionUrl:'https://fixture.test/functions/v1/api'},idToken:'synthetic'})};
   const features={membership:true,points:false,booking:false};
   let version=1,remoteFeatures={...features};
   w.fetch=async()=>({ok:true,json:async()=>({ok:true,data:{
     application:{status:'approved'},
     tenant:{slug:'synthetic',version,features:remoteFeatures,line:{},moduleLine:{}}
   }})});
   w.eval(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js'),'utf8'));
   await w.BusinessLineSettings.apply({features});
   assert.equal(w.document.querySelector('#businessLineFeatureTab-points'),null);
   // Root approval changes the authoritative tenant version.
   version=2;remoteFeatures={...features,points:true};
   w.dispatchEvent(new w.Event('focus'));
   for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
   assert.ok(w.document.querySelector('#businessLineFeatureTab-points'),
     'new server version must unlock a newly authorized module without re-login');
   // A subsequently revoked grant must remain revoked when a stale server
   // response reports the same version.
   await w.BusinessLineSettings.apply({features:{...remoteFeatures,points:false},business:{slug:'synthetic'}});
   for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
   assert.equal(w.document.querySelector('#businessLineFeatureTab-points'),null,
     'same-version old response must never undo local revocation');
 }finally{w.close();}
});
