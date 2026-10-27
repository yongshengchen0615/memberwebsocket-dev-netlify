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
