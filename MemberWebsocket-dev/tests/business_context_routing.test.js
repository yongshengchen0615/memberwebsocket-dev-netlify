const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const calls=[],listeners={},location=new URL('https://app.test/admin/workspace.html?business=merchant-a');
 const links=[{href:'https://app.test/admin/',dataset:{businessSwitch:'true'}},{href:'https://app.test/member/',dataset:{}},{href:'https://app.test/admin/workspace.html?business=merchant-b',dataset:{}}];
 const window={location,fetch:async(input,init)=>{calls.push({input,body:init?.body&&JSON.parse(init.body)});return new Response('{}');}};
 const context={window,location,URL,URLSearchParams,document:{documentElement:{},querySelectorAll:()=>links,addEventListener:(name,callback)=>listeners[name]=callback},MutationObserver:class{observe(){}},Response};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../business-context.js'),'utf8'),context);
 return{window,calls,links,listeners};
}
test('merchant account operations keep fixed Channel routing while selected settings retain business scope',async()=>{
 const h=fixture();
 for(const action of ['platform.qualification.bootstrap','platform.qualification.submit','platform.qualification.list','platform.qualification.review','platform.merchant.list','platform.merchant.submit','platform.merchant.get','platform.merchant.review']){
  await h.window.fetch('https://fixture.supabase.co/functions/v1/platform-api',{method:'POST',body:JSON.stringify({action,idToken:'synthetic'})});
  assert.equal(h.calls.at(-1).body.business,undefined,action);
 }
 await h.window.fetch('https://fixture.supabase.co/functions/v1/platform-api',{method:'POST',body:JSON.stringify({action:'platform.line.save'})});
 assert.equal(h.calls.at(-1).body.business,'merchant-a');
 await h.window.fetch('https://fixture.supabase.co/functions/v1/api',{method:'POST',body:JSON.stringify({action:'admin.bootstrap'})});
 assert.equal(h.calls.at(-1).body.business,'merchant-a');
});
test('return-to-my-merchants link drops selected business; ordinary module navigation retains current business',()=>{
 const h=fixture();h.listeners.DOMContentLoaded();
 assert.equal(h.links[0].href,'https://app.test/admin/');
 assert.equal(h.links[1].href,'https://app.test/member/?business=merchant-a');
 assert.equal(h.links[2].href,'https://app.test/admin/workspace.html?business=merchant-b');
});
