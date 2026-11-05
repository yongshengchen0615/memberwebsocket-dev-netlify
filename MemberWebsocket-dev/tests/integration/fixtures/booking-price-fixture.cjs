const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path');
const actor='U'+'5'.repeat(32);
const a='10000000-0000-4000-8000-000000000001';
const b='10000000-0000-4000-8000-000000000002';
const tenant='business_'+'a'.repeat(32);
const other='business_'+'b'.repeat(32);
const dir=path.resolve(__dirname,'../../../supabase/migrations');
const file=fs.readdirSync(dir).find(x=>x.endsWith('_booking_item_price_publishing.sql'));
const migration=file?fs.readFileSync(path.join(dir,file),'utf8'):'';
module.exports=async(options={})=>{
 const db=options.db||new PGlite();
 await db.exec(`${options.rolesCreated?'':'create role anon;create role authenticated;create role service_role bypassrls;'}
 create schema platform_private;
 create table platform_private.tenants(id uuid primary key,runtime_schema text,owner_line_user_id text,status text default 'active',features jsonb default '{"booking":true}',expires_at timestamptz,access_revoked_before timestamptz);
 create table platform_private.admin_qualifications(applicant_line_user_id text primary key,status text,access_revoked_before timestamptz);
 create table public.admins(line_user_id text primary key,status text,role text default 'admin');
 create table public.booking_services(id uuid primary key default gen_random_uuid(),title text not null,duration_minutes integer default 30,price_amount integer not null default 0,is_active boolean default true,deleted_at timestamptz,created_by text,updated_at timestamptz default clock_timestamp());
 create table public.booking_items(id uuid primary key default gen_random_uuid(),service_id uuid,unit_price_amount integer,service_title text);
 create table public.booking_participant_items(like public.booking_items including defaults);
 create table public.booking_audit_events(actor_line_user_id text,actor_role text,action text,target_type text,target_id text,result text,metadata jsonb);
 create function public.platform_provision_business(p_tenant_id uuid) returns void language plpgsql as $$begin return;end$$;
 insert into public.admins(line_user_id,status) values('${actor}','active');
 insert into platform_private.admin_qualifications values('${actor}','approved',null);
 insert into platform_private.tenants(id,runtime_schema,owner_line_user_id) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${tenant}','${actor}'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${other}','U${'6'.repeat(32)}');
 create schema ${tenant}; create schema ${other};
 `);
 for(const s of [tenant,other]){
  for(const table of ['admins','booking_services','booking_items','booking_participant_items','booking_audit_events'])await db.exec(`create table ${s}.${table}(like public.${table} including all)`);
  await db.query(`insert into ${s}.admins(line_user_id,status) values($1,'active')`,[s===tenant?actor:'U'+'6'.repeat(32)]);
 }
 for(const s of ['public',tenant,other])await db.query(`insert into ${s}.booking_services(id,title,price_amount,created_by) values($1,'A',500,$3),($2,'B',900,$3)`,[a,b,actor]);
 for(const s of ['public',tenant,other])await db.exec(`create function ${s}.create_price_fixture_booking(p_service uuid) returns void language plpgsql as $$declare svc ${s}.booking_services;begin select * into svc from ${s}.booking_services where id=p_service for share;insert into ${s}.booking_items(service_id,unit_price_amount) values(p_service,svc.price_amount);end$$`);
 for(const s of ['public',tenant,other])await db.exec(`
  create table ${s}.price_fixture_members(id integer primary key);insert into ${s}.price_fixture_members values(1);
  create function ${s}.fixture_receipt_wrapper(p_service uuid) returns void language plpgsql as $$begin
   perform 1 from ${s}.price_fixture_members where id=1 for update;
   perform pg_advisory_xact_lock(778899);
   perform ${s}.create_price_fixture_booking(p_service);
  end$$;
  create function ${s}.fixture_group_lock(p_service uuid) returns void language plpgsql as $$begin
   perform 1 from ${s}.booking_services where id=p_service for share;
   perform 1 from ${s}.price_fixture_members where id=1 for update;
  end$$;
 `);
 if(options.runtimePreRequest){
  await db.exec(`create table platform_private.applications(tenant_id uuid,applicant_line_user_id text,status text);
   insert into platform_private.applications select id,owner_line_user_id,'approved' from platform_private.tenants;
   grant usage on schema public,platform_private,${tenant},${other} to service_role;
   grant select,update on all tables in schema platform_private to service_role;
   grant select,insert,update on all tables in schema public,${tenant},${other} to service_role;`);
  await db.exec(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(x=>x.startsWith('20261025013038_'))),'utf8'));
 }
 if(migration)await db.exec(migration);
 for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('_booking_immediate_price_publication_status.sql')))await db.exec(fs.readFileSync(path.join(dir,name),'utf8'));
 const one=async(sql,args=[]) =>(await db.query(sql,args)).rows[0];
 const resolve=async(id,s=tenant)=>(await one(`select ${s}.booking_price_resolve($1) value`,[id])).value;
 const publish=async(id,price,time=null,request=crypto.randomUUID(),version=null,s=tenant)=>{
  const current=version||((await resolve(id,s)).priceVersion);
  return (await one(`select ${s}.booking_price_publish($1,$2,$3,$4,$5,$6) value`,[id,price,time,request,actor,current])).value;
 };
 const clock=iso=>db.query("select set_config('app.booking_price_at',$1,false)",[iso||'']);
 const quote=values=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-booking-price-preview':'1','x-booking-price-check':'1','x-booking-price-quote':JSON.stringify(values)})]);
 return{db,one,resolve,publish,clock,quote,actor,a,b,tenant,other,migration};
};
