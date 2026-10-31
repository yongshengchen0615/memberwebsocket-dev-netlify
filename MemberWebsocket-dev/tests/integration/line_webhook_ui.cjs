const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const until=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.ok(check(),'UI did not reach expected state');};
test('#144 unsaved Messaging draft disables check and the invocation guard prevents checking stale credentials',async()=>{
 const dom=new JSDOM('<nav id="businessLineFeatureNav"></nav><div id="businessLineFeatureContent"></div>',{url:'https://fixture.test/admin/?business=synthetic',runScripts:'outside-only'}),w=dom.window;let checks=0;
 try{
  w.AbortSignal=AbortSignal;w.MemberAdminSession={get:()=>({config:{business:'synthetic',supabaseFunctionUrl:'https://fixture.test/functions/v1/api'},idToken:'synthetic'})};
  w.fetch=async(_url,options)=>{if(JSON.parse(options.body).action==='platform.webhook.check')checks++;return{ok:true,json:async()=>({ok:true,data:{application:{status:'approved'},tenant:{slug:'synthetic',version:1,features:{booking:true},line:{},moduleLine:{}}}})};};
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js'),'utf8'));await w.BusinessLineSettings.apply({features:{booking:true}});
  const form=w.document.querySelector('#businessLine-booking'),check=[...w.document.querySelectorAll('[data-line-webhook=booking] button')].find(b=>b.textContent==='檢查 LINE 連線');assert.equal(check.disabled,false);
  form.elements.bookingLiffId.value='2010787602-synthetic';form.elements.bookingLiffId.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(check.disabled,true);
  await check.onclick();assert.equal(checks,0);
 }finally{w.close();}
});
test('#144 existing LINE tab can read status and check connection with real platform handler and SQL',async()=>{
 const h=await require('./fixtures/line-webhook-http.cjs').setup();let dom;
 try{
  dom=new JSDOM('<nav id="businessLineFeatureNav"></nav><div id="businessLineFeatureContent"></div>',{url:'https://allowed.test/admin/?business='+h.tenant.slug,runScripts:'outside-only'});const w=dom.window;
  w.AbortSignal=AbortSignal;w.MemberAdminSession={get:()=>({config:{business:h.tenant.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api'},idToken:'manager'})};
  w.fetch=(url,options)=>h.handler(new Request(url,{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js'),'utf8'));await w.BusinessLineSettings.apply({features:{booking:true}});
  const panel=w.document.querySelector('[data-line-webhook=booking]'),buttons=[...panel.querySelectorAll('button')];
  buttons.find(b=>b.textContent==='讀取 Webhook 狀態').click();await until(()=>panel.querySelector('[role=status]').textContent.includes('尚未確認'));assert.equal(h.provider.length,0);
  buttons.find(b=>b.textContent==='檢查 LINE 連線').click();await until(()=>panel.querySelector('[role=status]').textContent.includes('已接受連線檢查'));assert.equal(h.provider.length,2);
  assert.equal(panel.querySelector('input').value,'https://fixture.supabase.co/functions/v1/line-webhook');assert.equal(buttons.find(b=>b.textContent==='複製 Webhook URL').disabled,false);
 }finally{dom?.window.close();await h.db.close();}
});
