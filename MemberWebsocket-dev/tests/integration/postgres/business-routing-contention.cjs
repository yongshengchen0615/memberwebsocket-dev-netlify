const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const database=require('./database.cjs');
const migrations=path.resolve(__dirname,'../../../supabase/migrations');
const source=name=>fs.readFileSync(path.join(migrations,name),'utf8');

async function setup(){
 const {db}=await database();
 try{
  await db.exec(`create schema platform_private;
   create table platform_private.tenants(id uuid,slug text,runtime_schema text,owner_line_user_id text,status text);
   create table platform_private.admin_qualifications(applicant_line_user_id text,status text,access_revoked_before timestamptz);
   insert into platform_private.tenants values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','shop-a','business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','owner-a','active');
   insert into platform_private.admin_qualifications values('owner-a','approved',null);
   grant usage on schema platform_private to service_role;
   grant select on all tables in schema platform_private to service_role;`);
  // Execute the original metadata RPC and the real historical broad lock injection.
  await db.exec(source('20261024142522_merchant_explicit_context.sql').match(/create function public\.platform_business_context_v2[\s\S]*?\nend \$\$;/i)[0]);
  const prices=source('20261105044538_booking_item_price_publishing.sql');
  await db.exec(prices.match(/create or replace function platform_private\.booking_price_authority_lock\(\)[\s\S]*?end \$locks\$;/i)[0]);
  await db.exec(prices.match(/do \$control_guards\$[\s\S]*?end \$control_guards\$;/i)[0]);
  await db.exec(`revoke all on function public.platform_business_context_v2(text,text) from public,anon,authenticated;
   grant execute on function public.platform_business_context_v2(text,text) to service_role;`);
  const before=(await db.query("select public.platform_business_context_v2(null,'shop-a') value")).rows[0].value;
  const repair=fs.readdirSync(migrations).find(name=>name.endsWith('_business_routing_nonblocking_metadata.sql'));
  if(repair)await db.exec(source(repair));
  return{db,before,repair};
 }catch(error){await db.close();throw error;}
}

test('CRUD-LOG AC-003: metadata routing reads complete while another transaction holds a price authority lock',async()=>{
 const {db,before}=await setup(),holder=await db.connect(),reader=await db.connect();
 try{
  await holder.query('begin');
  await holder.query("select pg_advisory_xact_lock(hashtextextended('booking-prices:public',0))");
  await reader.query("set lock_timeout='300ms'");
  await reader.query('set role service_role');
  const actual=(await reader.query("select public.platform_business_context_v2(null,'shop-a') value")).rows[0].value;
  assert.deepEqual(actual,before,'routing output and qualification metadata must stay unchanged');
  const locks=(await reader.query("select count(*)::int n from pg_locks where pid=pg_backend_pid() and locktype='advisory'")).rows[0].n;
  assert.equal(locks,0);
 }finally{await holder.query('rollback');await db.close();}
});

test('CRUD-LOG AC-003: metadata migration replay and rollback retain service-role-only invoker privileges',async()=>{
 const {db,before,repair}=await setup();
 try{
  if(repair)await db.exec(source(repair));
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);
   await assert.rejects(db.query("select public.platform_business_context_v2(null,'shop-a')"),/permission denied/);
   await db.exec('reset role');
  }
  assert.equal((await db.query("select prosecdef from pg_proc where oid='public.platform_business_context_v2(text,text)'::regprocedure")).rows[0].prosecdef,false);
  await db.exec('begin');
  await db.exec("update platform_private.admin_qualifications set status='suspended'");
  assert.equal((await db.query("select public.platform_business_context_v2(null,'shop-a') value")).rows[0].value.owner_qualification_status,'suspended');
  await db.exec('rollback');
  assert.deepEqual((await db.query("select public.platform_business_context_v2(null,'shop-a') value")).rows[0].value,before);
  assert.equal((await db.query("select public.platform_business_context_v2(null,'missing') value")).rows[0].value,null);
  await db.exec("insert into platform_private.tenants values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','shop-b','business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','owner-a','active')");
  await assert.rejects(db.query("select public.platform_business_context_v2('owner-a',null)"),/PLATFORM_BUSINESS_SELECTION_REQUIRED/);
 }finally{await db.close();}
});
