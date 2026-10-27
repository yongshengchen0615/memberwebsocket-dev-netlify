const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('preview member writes use the configured isolated endpoint; production retains its original endpoint',async()=>{
 const urls=[];
 const context=vm.createContext({window:{setTimeout,clearTimeout},document:{addEventListener(){},removeEventListener(){},querySelector(){return {}; }},URL,AbortController,Map,Set,Date,console,
  fetch:async(url)=>{urls.push(url);return{ok:true,status:200,text:async()=>JSON.stringify({ok:true,data:{saved:true}})};}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../member-system.js'),'utf8'),context);
 const config={supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic',memberLiffId:'1234567890-synthetic',realtimeEnabled:false};
 const preview={...config,memberProfileFunctionUrl:'https://example.supabase.co/functions/v1/member-profile-api-preview'};
 await context.window.MemberSystem.request(preview,'member','id','user.member.profile.save',{accepted:true});
 await context.window.MemberSystem.request(config,'member','id','user.member.profile.save',{accepted:true});
 assert.deepEqual(urls,['https://example.supabase.co/functions/v1/member-profile-api-preview','https://example.supabase.co/functions/v1/member-profile-api']);
});

test('preview config discovers the merchant through platform-api before using the isolated member API',async()=>{
 const {previewMemberRuntime}=await import('../../scripts/preview-member-runtime.mjs');
 const config=previewMemberRuntime({supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic',memberLiffId:'1234567890-synthetic'},{BRANCH:'Integrated-Marketing-Platform'});
 const calls=[],location={origin:'https://preview.example',href:'https://preview.example/member/?business=test',pathname:'/member/',search:'?business=test'};
 const window={location,setTimeout,clearTimeout,fetch:async(url,options={})=>{
  const address=String(url),body=options.body?JSON.parse(options.body):null;calls.push({url:address,body});
  const result=address==='/config.json'?config:address.endsWith('/platform-api')?{ok:true,data:{business:'test',name:'Synthetic',features:{membership:true},line:{memberLiffId:'1234567890-synthetic'}}}:address.endsWith('/member-profile-api-preview')?{ok:true,data:{saved:true}}:{ok:false,error:{message:'Wrong control-plane endpoint'}};
  return{ok:result.ok!==false,status:result.ok===false?400:200,text:async()=>JSON.stringify(result),json:async()=>result};
 }};
 const context=vm.createContext({window,location,document:{addEventListener(){},removeEventListener(){},querySelector(){return {};},querySelectorAll(){return[];}},URL,URLSearchParams,AbortController,Map,Set,Date,console,fetch:(...args)=>window.fetch(...args)});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../business-context.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../member-system.js'),'utf8'),context);
 const configured=await window.MemberSystem.loadConfig();
 await window.MemberSystem.request(configured,'member','id','user.member.profile.save',{accepted:true});
 assert.equal(calls[1].url,'https://example.supabase.co/functions/v1/platform-api');
 assert.equal(calls[2].url,'https://example.supabase.co/functions/v1/member-profile-api-preview');
 assert.equal(calls[2].body.business,'test');
});
