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
