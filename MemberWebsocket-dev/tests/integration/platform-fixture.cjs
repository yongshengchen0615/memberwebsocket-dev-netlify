const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {pathToFileURL}=require('node:url');
const shared=name=>import(pathToFileURL(path.join(__dirname,'../../supabase/functions/_shared',name)));
const root='U'+'1'.repeat(32),manager='U'+'2'.repeat(32),key=Buffer.alloc(32,7).toString('base64');
const tenantId='10000000-0000-4000-8000-000000000001';
const migration=fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261017131559_product_platform_control_plane.sql'),'utf8');
async function fixture(adminCount=1) {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table public.admins(id uuid primary key default gen_random_uuid(),line_user_id text unique,display_name text,role text,status text);
 grant select on public.admins to service_role;
 create table public.legacy_member_data(id uuid primary key default gen_random_uuid());
 insert into public.admins(line_user_id,role,status)values('${root}','admin','active');`);
 if(adminCount===2)await db.query("insert into admins(line_user_id,role,status)values($1,'admin','active')",[manager]);
 await db.exec(migration);
 if(adminCount===1)await db.query("insert into admins(line_user_id,role,status)values($1,'admin','active')",[manager]);
 const rpc=async(name,p)=>{
  if(name==='consume_api_rate_limit')return {data:true,error:null}; // Existing shared limiter has its own baseline tests.
  const args={platform_is_super_admin:['p_actor'],platform_list_tenants:['p_actor'],platform_save_tenant:['p_actor','p_request_id','p_payload_hash','p_tenant_id','p_expected_version','p_tenant','p_secrets'],platform_suspend_tenant:['p_actor','p_tenant_id','p_expected_version','p_request_id']}[name];
  assert.ok(args,'Unmodeled RPC '+name);
  try {const sql=`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`;
   const rows=await db.transaction(async tx=>{await tx.exec('set local role service_role');return (await tx.query(sql,args.map(k=>p[k]??null))).rows;});
   return {data:name==='platform_list_tenants'?rows.map(r=>r.result):rows[0]?.result,error:null};
  }catch(error){return {data:null,error};}
 };
 const {createPlatformHandler}=await shared('platform-handler.js');
 const {PlatformError}=await shared('platform-policy.js');
 const handler=createPlatformHandler({db:{rpc},encryptionKey:()=>key,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async token=>{
   if(token==='root')return {lineUserId:root,displayName:'總管理員'};
   if(token==='manager')return {lineUserId:manager,displayName:'商家管理員'};
   throw new PlatformError(401,'AUTH_INVALID','登入已失效。');
 }});
 const call=async(body,token='root')=>{const res=await handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({...body,idToken:token})}));return {status:res.status,body:await res.json()};};
 const {FEATURES}=await shared('platform-policy.js');
 const tenant={name:'商家 A',slug:'merchant-a',ownerLineUserId:manager,features:Object.fromEntries(Object.keys(FEATURES).map(k=>[k,true])),line:{adminChannelId:'2010791619',memberChannelId:'2010787602',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin',memberLiffId:'2010787602-member',pointsLiffId:'2010787602-points',eventLiffId:'2010787602-event',calendarLiffId:'2010787602-calendar',bookingLiffId:'2010787602-booking'},credentials:{channelAccessToken:'synthetic-access-token-123456789',channelSecret:'a'.repeat(32)}};
 const save={action:'platform.tenant.save',tenantId,expectedVersion:0,requestId:crypto.randomUUID(),tenant};
 return {db,rpc,call,save,tenant,handler};
}


module.exports={fixture,shared,root,manager,key,tenantId,migration};
