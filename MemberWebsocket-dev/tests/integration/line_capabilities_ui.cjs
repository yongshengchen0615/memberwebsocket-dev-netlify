// Catches a form-level required Messaging field preventing LIFF-only save,
// or readiness hiding a successfully configured no-secret feature entry.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),fixture=require('./business-platform-fixture.cjs');
const until=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.ok(check(),'UI never reached expected state');};
test('#124 LIFF-only form saves valid Calendar Login/LIFF and exposes its saved entry without requesting Messaging credentials',async()=>{
 const h=await fixture();let dom;try{
  const features={membership:false,points:false,events:false,calendar:true,booking:false,integrations:false,testing:false,usage:false},t=await h.approve('U'+'2'.repeat(32),'calendar-only-ui',features);
  dom=new JSDOM('<section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div>',{url:'https://allowed.test/admin/?business='+t.slug,runScripts:'outside-only'});
  const w=dom.window;w.AbortSignal=AbortSignal;w.MemberAdminSession={get:()=>({config:{business:t.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'},idToken:'manager'})};
  w.fetch=(url,options)=>h.handler(new Request(url,{...options,headers:{...options.headers,Origin:'https://allowed.test'}}));
  w.eval(fs.readFileSync(process.env.LINE_UI_TEST_SOURCE||path.join(__dirname,'../../admin/business-line-settings.js'),'utf8'));
  await w.BusinessLineSettings.apply({features});const d=w.document;await until(()=>d.querySelector('#businessLine-calendar'));
  const form=d.querySelector('#businessLine-calendar');
  for(const [key,value]of Object.entries({adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',calendarLiffId:'2010787602-calendar'})){
   form.elements[key].value=value;form.elements[key].dispatchEvent(new w.Event('input',{bubbles:true}));
  }
  assert.equal(form.checkValidity(),true,'a complete Login/LIFF entry must be submittable without Messaging credentials');
  form.dispatchEvent(new w.Event('submit',{cancelable:true}));
  await until(()=>d.querySelector('[data-business-line-feature="calendar"] > [role=status]').textContent.includes('已儲存'));
  const saved=[...d.querySelectorAll('[data-business-line-feature="calendar"] a')].find(a=>a.textContent==='開啟已儲存的 LINE 入口');
  assert.equal(saved.href,'https://liff.line.me/2010787602-calendar');assert.equal(d.querySelector('#notification-calendar-member'),null);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,0);
 }finally{dom?.window.close();await h.db.close();}
});
