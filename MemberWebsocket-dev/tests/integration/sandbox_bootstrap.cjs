const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const pathOf=name=>path.join(__dirname,'../../supabase/migrations',name);
const rootSql='select maintenance.bootstrap_sandbox_root($1,$2) result';
const confirm='RESTORE ROOT AFTER VERIFIED SANDBOX RESET';
const uid='U'+'a'.repeat(32);
async function setup(){
 const db=new PGlite();
 try {
  await db.exec([
    'create role anon;create role authenticated;create role service_role;',
    'create schema maintenance;create schema platform_private;create schema auth;create schema storage;',
    'create table public.admins(id uuid primary key default gen_random_uuid(),line_user_id text unique not null, display_name text not null,role text not null,status text not null);',
    'create table public.members(id uuid primary key default gen_random_uuid());',
    'create table platform_private.super_admins(singleton boolean primary key,admin_id uuid references public.admins(id) on delete restrict,enabled boolean,line_user_id text not null);',
    'create table platform_private.tenants(id uuid primary key);',
    'create table auth.users(id uuid primary key);',
    'create table storage.objects(id uuid primary key);'
  ].join('\n'));
  for(const name of ['20261023183000_approved_existing_sandbox_scope.sql','20261023190000_sandbox_root_bootstrap_gate.sql'])
   await db.exec(fs.readFileSync(pathOf(name),'utf8'));
  return db;
 }catch(error){await db.close();throw error}
}
async function markReset(db){
 await db.exec("update maintenance.sandbox_reset_epoch set last_completed_request='11111111-1111-4111-8111-111111111111',last_completed_at=now(),root_bootstrap_required=true,bootstrapped_at=null where singleton=true;");
}
async function count(db,t){return (await db.query('select count(*)::int n from '+t)).rows[0].n}

test('AC-CLR-012: root cannot be created without an attested prior successful sandbox reset',async()=>{
 const db=await setup();
 try {
  await assert.rejects(db.query(rootSql,[uid,confirm]),/VERIFIED_RESET_REQUIRED_BEFORE_ROOT_BOOTSTRAP/);
  assert.equal(await count(db,'public.admins'),0);
  assert.equal(await count(db,'platform_private.super_admins'),0);
 }finally{await db.close()}
});

test('AC-CLR-013: after a verified reset, root is restored exactly once and linked to an active admin',async()=>{
 const db=await setup();
 try{
  await markReset(db);
  const result=(await db.query(rootSql,[uid,confirm])).rows[0].result;
  assert.equal(result.bootstrapped,true);
  assert.equal(result.bootstrapSingleUse,true);
  const root=(await db.query('select s.enabled,s.line_user_id,a.role,a.status,a.id=s.admin_id linked from platform_private.super_admins s join public.admins a on a.id=s.admin_id')).rows[0];
  assert.equal(root.enabled,true);
  assert.equal(root.line_user_id,uid);
  assert.equal(root.role,'admin');
  assert.equal(root.status,'active');
  assert.equal(root.linked,true);
  assert.equal(await count(db,'platform_private.super_admins'),1);
  await assert.rejects(db.query(rootSql,[uid,confirm]),/VERIFIED_RESET_REQUIRED_BEFORE_ROOT_BOOTSTRAP/);
  assert.equal(await count(db,'public.admins'),1);
  assert.equal((await db.query('select root_bootstrap_required from maintenance.sandbox_reset_epoch')).rows[0].root_bootstrap_required,false);
 }finally{await db.close()}
});

test('AC-CLR-014: malformed LINE id, wrong confirmation and nonempty tenant block bootstrap atomically',async()=>{
 const db=await setup();
 try {
  await markReset(db);
  await assert.rejects(db.query(rootSql,[uid,'WRONG']),/ROOT_BOOTSTRAP_CONFIRMATION_REQUIRED/);
  await assert.rejects(db.query(rootSql,['INVALID',confirm]),/INVALID_LINE_ID/);
  await db.exec("insert into platform_private.tenants(id) values('11111111-1111-4111-8111-111111111111')");
  await assert.rejects(db.query(rootSql,[uid,confirm]),/SANDBOX_NOT_EMPTY_FOR_ROOT_BOOTSTRAP/);
  assert.equal(await count(db,'public.admins'),0);
  assert.equal(await count(db,'platform_private.super_admins'),0);
 }finally{await db.close()}
});

test('AC-CLR-015: anonymous, authenticated and service roles cannot perform root bootstrap',async()=>{
 const db=await setup();
 try {
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',
     [role,'maintenance.bootstrap_sandbox_root(text,text)','EXECUTE'])).rows[0].allowed,false,role);
  }
  assert.equal(await count(db,'maintenance.sandbox_reset_epoch'),1);
 }finally{await db.close()}
});
