import { businessHandler,createClient } from './business-runtime.ts';
import { businessEnv,businessFetch } from './business-scope.ts';
const assert=(condition:unknown,message='assertion failed')=>{if(!condition)throw Error(message);};
const ownerA='U'+'a'.repeat(32),ownerB='U'+'b'.repeat(32);
const token=(sub:string)=>'e30.'+btoa(JSON.stringify({sub}))+'.signature';
const a={id:'10000000-0000-4000-8000-000000000001',slug:'merchant-a',name:'A',status:'active',runtime_schema:'business_'+'a'.repeat(32),owner_line_user_id:ownerA,features:{membership:true,points:true,booking:true},line_config:{},credentials_configured:false};
const b={...a,id:'20000000-0000-4000-8000-000000000002',slug:'merchant-b',name:'B',runtime_schema:'business_'+'b'.repeat(32),owner_line_user_id:ownerB};
Deno.test('AC-210: production request adapter enforces fresh grants, private schemas, storage prefixes and concurrent isolation',async()=>{
 const previousEnv=Deno.env.get;
 Deno.env.get=(key:string)=>({SUPABASE_URL:'https://runtime-fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only-fixture'} as Record<string,string>)[key];
 const previous=globalThis.fetch,calls:any[]=[];let latestA=structuredClone(a);
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),headers=new Headers(init?.headers);
  const body=typeof init?.body==='string'?JSON.parse(init.body):{};
  calls.push({path:url.pathname,headers,body});
  const reply=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  if(url.pathname.endsWith('/platform_business_context'))return reply(body.p_slug==='merchant-b'||body.p_actor===ownerB?b:latestA);
  if(url.pathname.endsWith('/members')){await new Promise(r=>setTimeout(r,2));return reply([{id:headers.get('accept-profile')}]);}
  if(url.pathname.includes('/storage/v1/object/sign/'))return reply({signedURL:'/object/sign/'+url.pathname.split('/sign/')[1]+'?token=fixture'});
  if(url.hostname==='api.line.me')return reply({ok:true});
  throw Error('Unexpected transport '+url.href);
 }) as typeof fetch;
 try{
  let invoked=0;
  const handler=businessHandler('api',async()=>{
   invoked++;
   await Promise.resolve();
   const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
   const result=await db.from('members').select('id');
   return new Response(JSON.stringify({ok:true,data:result.data}));
  });
  const request=(business='merchant-a',action='admin.pointcards.save',idToken=token(ownerA))=>new Request('https://api.test',{method:'POST',headers:{Origin:'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app'},body:JSON.stringify({business,action,idToken})});
  const res=await handler(request());assert(res.status===200);assert((await res.json()).data[0].id===a.runtime_schema);
  const before=invoked;latestA.features.points=false;
  assert((await handler(request())).status===403);assert(invoked===before,'disabled action must not execute its handler');
  latestA=structuredClone(a);latestA.status='suspended';assert((await handler(request())).status===403);
  latestA=structuredClone(a);
  assert((await handler(request('merchant-b'))).status===403,'foreign admin cannot create pending rows in another business');
  const concurrent=await Promise.all(Array.from({length:16},(_,i)=>handler(i%2?request('merchant-b','admin.pointcards.save',token(ownerB)):request())));
  for(const [i,res]of concurrent.entries())assert((await res.json()).data[0].id===(i%2?b:a).runtime_schema,'async scopes crossed');
  const storage=businessHandler('api',async()=>{
   const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
   const url=await db.storage.from('booking-receipts').createSignedUrl('member/a.png',60);
   assert(url.data?.signedUrl.includes(a.id+'/member/a.png'));
   let rejected=false;try{await db.storage.from('booking-receipts').remove(['../other-business/a.png']);}catch{rejected=true;}assert(rejected);
   assert(businessEnv('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN')==='','must never fall back to the legacy LINE token');
   await businessFetch('https://api.line.me/v2/bot/message/push',{method:'POST',body:JSON.stringify({messages:[{action:{uri:'https://liff.line.me/2010787602-example'}}]})});
   return new Response('{}');
  });
  assert((await storage(request('merchant-a','admin.bootstrap'))).ok);
  const pushed=calls.find(c=>c.path==='/v2/bot/message/push');assert(pushed.body.messages[0].action.uri.endsWith('?business=merchant-a'));
 }finally{globalThis.fetch=previous;Deno.env.get=previousEnv;}
});
