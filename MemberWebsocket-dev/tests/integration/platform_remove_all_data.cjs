const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const migration=fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261018182000_remove_all_business_data.sql'),'utf8');
test('AC-022: remove-all requires explicit confirmation and revokes the platform session',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`
   create role anon;create role authenticated;create role service_role;
   create schema maintenance;create schema platform_private;
   create table public.admins(id int primary key);
   create table public.members(id int primary key);
   create table platform_private.super_admins(singleton boolean primary key,enabled boolean not null);
   create table platform_private.tenants(id int primary key);
   create table platform_private.applications(id int primary key,tenant_id int references platform_private.tenants(id));
   create table platform_private.tenant_secrets(tenant_id int references platform_private.tenants(id));
   create table platform_private.audit_events(tenant_id int references platform_private.tenants(id));
   create table platform_private.requests(id int primary key);
   create function maintenance.clear_public_data(confirm_clear boolean default false)
    returns table(truncated_table_count integer)
    language plpgsql set search_path=''
    as $stub$ begin
      if confirm_clear is distinct from true then raise exception 'CONFIRM_REQUIRED'; end if;
      truncate public.members restart identity;return query select 1;
    end;$stub$;
   insert into public.admins values(1);insert into public.members values(2);
   insert into platform_private.super_admins values(true,true);
   insert into platform_private.tenants values(3);
   insert into platform_private.applications values(4,3);
   insert into platform_private.tenant_secrets values(3);
   insert into platform_private.audit_events values(3);
   insert into platform_private.requests values(5);
  `);
  await db.exec(migration);
  const permission=await db.query("select has_function_privilege('service_role','maintenance.remove_all_data(text)','EXECUTE') as allowed");
  assert.equal(permission.rows[0].allowed,false);
  await assert.rejects(db.query('select * from maintenance.remove_all_data()'),/CONFIRM_REMOVE_ALL_DATA_REQUIRED/);
  await assert.rejects(db.query("select * from maintenance.remove_all_data('NO')"),/CONFIRM_REMOVE_ALL_DATA_REQUIRED/);
  assert.equal((await db.query('select count(*)::int n from public.members')).rows[0].n,1);
  const result=(await db.query("select * from maintenance.remove_all_data('REMOVE ALL DATA')")).rows[0];
  assert.equal(result.truncated_table_count,1);
  assert.equal(Number(result.removed_platform_rows),5);
  for(const table of ['public.members','platform_private.tenants','platform_private.applications','platform_private.tenant_secrets','platform_private.audit_events','platform_private.requests'])
   assert.equal((await db.query('select count(*)::int n from '+table)).rows[0].n,0,table);
  assert.equal((await db.query('select count(*)::int n from public.admins')).rows[0].n,1);
  assert.equal((await db.query('select enabled from platform_private.super_admins')).rows[0].enabled,false);
 }finally{await db.close();}
});
