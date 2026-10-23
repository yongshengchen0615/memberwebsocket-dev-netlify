const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const migration=fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261023150000_full_reset_preflight.sql'),'utf8');
const TENANT='business_273cbfd6349b47eebf120e416527d2bb';

async function fixture(){
 const db=new PGlite();
 await db.exec([
  'create role anon; create role authenticated; create role service_role;',
  'create schema maintenance; create schema platform_private;',
  'create schema auth; create schema storage; create schema booking_notifications;',
  'create schema '+TENANT+';',
  'create table public.admins(id integer primary key);',
  'create table public.members(id integer primary key);',
  'create table public.audit_logs(id integer primary key);',
  'create table public.booking_settings(id integer primary key);',
  'create table platform_private.super_admins(id integer primary key,enabled boolean not null);',
  'create table platform_private.tenants(id integer primary key);',
  'create table platform_private.module_secrets(id integer primary key);',
  'create table auth.users(id integer primary key);',
  'create table storage.objects(id integer primary key);',
  'create table booking_notifications.outbox(id integer primary key);',
  'create table '+TENANT+'.members(id integer primary key);',
  'create table '+TENANT+'.admins(id integer primary key);',
  'insert into public.admins values(1);',
  'insert into public.members values(2);',
  'insert into public.audit_logs values(3);',
  'insert into public.booking_settings values(1);',
  'insert into platform_private.super_admins values(1,true);',
  'insert into platform_private.tenants values(1);',
  'insert into platform_private.module_secrets values(1);',
  'insert into auth.users values(1);',
  'insert into storage.objects values(1);',
  'insert into booking_notifications.outbox values(1);',
  'insert into '+TENANT+'.members values(1);',
  'insert into '+TENANT+'.admins values(1);'
 ].join('\n'));
 await db.exec(migration);
 return db;
}
function get(assets,schema,table){return assets.find(row=>row.schema===schema&&row.table===table)}

test('AC-CLR-001: inventory includes root, general admins, members, tenant, Auth, Storage, outbox',async()=>{
 const db=await fixture();
 try{
  const p=(await db.query('select maintenance.preview_full_reset() as report')).rows[0].report;
  assert.equal(p.readOnly,true);
  assert.equal(p.executionAllowed,false);
  assert.equal(p.complete,false);
  assert.equal(p.tableCount,12);
  assert.equal(p.nonEmptyTableCount,12);
  for(const [schema,table,category] of [
   ['public','admins','general_admins'],['public','members','members'],
   ['platform_private','super_admins','platform_control_plane'],
   ['platform_private','module_secrets','platform_control_plane'],
   [TENANT,'members','business_tenant'],[TENANT,'admins','business_tenant'],
   ['auth','users','managed_auth'],['storage','objects','managed_storage'],
   ['booking_notifications','outbox','notifications']]){
    const row=get(p.assets,schema,table);
    assert.equal(row?.category,category,schema+'.'+table);
    assert.equal(row?.hasRows,true);
   }
   assert.equal(get(p.assets,'public','audit_logs').disposition,'retention_review_required');
   assert.equal(get(p.assets,'storage','objects').disposition,'managed_api_review_required');
   assert.equal(p.blockers.length,7);
 }finally{await db.close()}
});

test('AC-CLR-003: preview never changes persisted rows or root enabled state',async()=>{
 const db=await fixture();
 try{
  const before=(await db.query('select enabled from platform_private.super_admins')).rows[0];
  const first=(await db.query('select maintenance.preview_full_reset() as p')).rows[0].p;
  const second=(await db.query('select maintenance.preview_full_reset() as p')).rows[0].p;
  assert.deepEqual(first,second);
  assert.deepEqual((await db.query('select enabled from platform_private.super_admins')).rows[0],before);
  for(const table of ['public.admins','public.members','platform_private.tenants',
                       TENANT+'.members','auth.users','storage.objects'])
   assert.equal((await db.query('select count(*)::int as n from '+table)).rows[0].n,1);
 }finally{await db.close()}
});

test('AC-CLR-002: anonymous, authenticated and service role cannot execute inventory',async()=>{
 const db=await fixture();
 try{
  for(const role of ['anon','authenticated','service_role']){
   const allowed=(await db.query("select has_function_privilege('"+role+"','maintenance.preview_full_reset()','EXECUTE') as ok")).rows[0].ok;
   assert.equal(allowed,false,role);
  }
 }finally{await db.close()}
});

test('AC-CLR-005: preflight discovers future tables and never enables execution',async()=>{
 const db=await fixture();
 try{
  await db.exec('delete from public.members; create table '+TENANT+'.booking_extensions(id int);');
  const p=(await db.query('select maintenance.preview_full_reset() as p')).rows[0].p;
  assert.equal(get(p.assets,'public','members').hasRows,false);
  assert.equal(get(p.assets,TENANT,'booking_extensions').hasRows,false);
  assert.equal(p.executionAllowed,false);
  assert.equal(p.tableCount,13);
  assert.equal(p.nonEmptyTableCount,11);
 }finally{await db.close()}
});
