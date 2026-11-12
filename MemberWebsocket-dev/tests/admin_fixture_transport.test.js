const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {fixture,transport}=require('./browser/admin-fixture.cjs');

function browserFixture(){
 const source=fs.readFileSync(path.join(__dirname,'browser/admin-fixture.cjs'),'utf8');
 const quote=String.fromCharCode(96);
 const marker="if(url.pathname==='/fixture.js')return send(200,'text/javascript',"+quote;
 const script=source.split(marker)[1].split(quote+');')[0];
 const calls=[];
 const context={URL,location:new URL('http://127.0.0.1:12345/admin/'),fetch:async(input,init)=>{calls.push({input,init});return{json:async()=>({ok:true,data:{}})};}};
 context.window=context;vm.runInNewContext(script,context);
 return{context,calls};
}

test('admin fixture routes the fake grant API locally without changing request semantics',async()=>{
 const {context,calls}=browserFixture();
 const config=await context.MemberSystem.loadConfig();
 assert.equal(config.supabaseGrantAutomationUrl,'https://fixture.supabase.co/functions/v1/grant-automation');
 const options={method:'POST',headers:{apikey:'synthetic-fixture'},body:JSON.stringify({action:'admin.calendar-items.list'}),signal:new AbortController().signal};
 await context.fetch(config.supabaseGrantAutomationUrl+'?diagnostic=1',options);
 assert.equal(calls[0].input,'http://127.0.0.1:12345/functions/v1/grant-automation?diagnostic=1');
 assert.equal(calls[0].init,options,'method, headers, body and cancellation signal must be retained');
});

test('admin fixture never redirects real projects, lookalike hosts or non-API resources',async()=>{
 const {context,calls}=browserFixture();
 for(const url of ['https://dbuquirnaskrwcamdxki.supabase.co/functions/v1/api','https://bmwhojszsnxliekkhrka.supabase.co/functions/v1/api','https://fixture.supabase.co.example/functions/v1/api','https://fixture.supabase.co/storage/v1/object','/functions/v1/api']){
  await context.fetch(url,{method:'GET'});assert.equal(calls.at(-1).input,url);
 }
});

test('admin fixture handles grant calendar reads and rejects unknown operations',()=>{
 const state=fixture();
 assert.deepEqual(transport(state,'admin.calendar-items.list',{},'grant-automation'),{calendarItems:[]});
 assert.throws(()=>transport(state,'unknown.fixture.operation',{},'grant-automation'),{code:'FIXTURE_UNEXPECTED_ACTION'});
 assert.deepEqual(state.unexpected,[{action:'unknown.fixture.operation',slug:'grant-automation'}]);
});
