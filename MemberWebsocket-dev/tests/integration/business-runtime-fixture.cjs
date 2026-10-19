const {PGlite}=require('@electric-sql/pglite');
const {btree_gist}=require('@electric-sql/pglite/contrib/btree_gist');
const fs=require('node:fs'),path=require('node:path');
const snapshot=require('./fixtures/business-template.cjs');
const q=id=>'"'+id.replaceAll('"','""')+'"';
const migrations=path.resolve(__dirname,'../../supabase/migrations');
const root='U'+'1'.repeat(32);
module.exports=async(options={})=>{
 const db=new PGlite({extensions:{btree_gist}});
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role authenticator;
   create schema extensions;create extension btree_gist with schema extensions;
   create schema storage;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
   create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text,updated_at timestamptz);
   create schema line_config;create table line_config.settings(setting_key text,value_text text,setting_type text);
   create schema cron;create table cron.job(jobid bigint,jobname text,active boolean,schedule text);
   create table cron.job_run_details(jobid bigint,runid bigint,status text,start_time timestamptz,end_time timestamptz);
   create function extensions.digest(text,text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;
   set search_path=public,extensions;set check_function_bodies=off;`);
  for(const seq of snapshot.sequences||[]){
   if(snapshot.tables.some(t=>t.columns.some(c=>c.identity&&t.name+'_'+c.name+'_seq'===seq.name)))continue;
   await db.exec(`create sequence public.${q(seq.name)}`);
  }
  for(const t of snapshot.tables){
   const cols=t.columns.map(c=>`${q(c.name)} ${c.type}${c.generated?` generated always as (${c.default}) stored`:c.identity?` generated ${c.identity==='a'?'always':'by default'} as identity`:''}${c.notNull?' not null':''}`);
   await db.exec(`create table public.${q(t.name)}(${cols.join(',')});`);
  }
  for(const f of snapshot.functions)await db.exec(f.definition);
  for(const t of snapshot.tables)for(const c of t.columns)if(c.default&&!c.generated)await db.exec(`alter table public.${q(t.name)} alter column ${q(c.name)} set default ${c.default}`);
  for(const c of [...snapshot.constraints.filter(c=>!['f','t'].includes(c.type)),...snapshot.constraints.filter(c=>c.type==='f')])await db.exec(`alter table public.${q(c.table)} add constraint ${q(c.name)} ${c.definition}`);
  for(const i of snapshot.indexes)await db.exec(i.definition);
  for(const t of snapshot.triggers)await db.exec(t.definition);
  await db.exec('set check_function_bodies=on;grant usage on schema public,storage to service_role;grant all on all tables in schema public,storage to service_role;grant all on all sequences in schema public to service_role;');
  await db.query("insert into public.admins(line_user_id,display_name,role,status)values($1,'root','admin','active')",[root]);
  for(const name of ['20261017131559_product_platform_control_plane.sql','20261017140939_platform_line_identity.sql','20261017164510_platform_admin_applications.sql','20261018012500_platform_feature_grants_only.sql','20261018181500_platform_manual_super_admin_grant.sql','20261019024033_business_runtime.sql','20261019122719_admin_access_lifecycle.sql','20261019122917_module_line_scope.sql'].filter(name=>options.beforeAccess?!name.includes('admin_access_lifecycle')&&!name.includes('module_line_scope'):true))await db.exec(fs.readFileSync(path.join(migrations,name),'utf8'));
  await db.exec('update platform_private.super_admins set enabled=true;');
  const approve=async(actor,slug,features=Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(k=>[k,true])))=>{
   const a=(await db.query('select public.platform_submit_application($1,$2,$3) a',[actor,slug,slug])).rows[0].a;
   return(await db.query('select public.platform_approve_application($1,$2,$3,$4) t',[root,a.id,features,crypto.randomUUID()])).rows[0].t;
  };
  return{db,approve,root};
 }catch(e){if(e.query)e.query=e.query.slice(0,300);await db.close();throw e;}
};
