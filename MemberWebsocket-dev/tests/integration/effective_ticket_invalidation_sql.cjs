const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const dir=path.resolve(__dirname,'../../supabase/migrations');
const read=name=>fs.readFileSync(path.join(dir,name),'utf8');
const tenant='business_'+'a'.repeat(32);
async function setup(){
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema platform_private;
   create table platform_private.business_templates(version text primary key,snapshot jsonb);
   insert into platform_private.business_templates values('business-v1-20261019','{"functions":[{"name":"unrelated","definition":"keep"}],"triggers":[{"name":"unrelated","table":"other","definition":"keep"}]}');`);
  for(const s of ['public',tenant]){
   if(s!=='public')await db.exec('create schema '+s);
   await db.exec(`create table ${s}.event_tickets(id uuid primary key,title text,status text,updated_at timestamptz);
    create table ${s}.event_ticket_claims(like ${s}.event_tickets including all);
    create table ${s}.calendar_items(like ${s}.event_tickets including all);
    create table ${s}.realtime_events(id bigint generated always as identity,scope text,event_type text);`);
   for(const [file,name] of [
    ['20260910_transactional_realtime_invalidation.sql','emit_realtime_invalidation'],
    ['20260911002500_calendar_holiday_member_realtime.sql','notify_admin_config_realtime_change'],
    ['20260920145127_complete_member_record_realtime_invalidation.sql','notify_member_record_realtime_change'],
   ]){
    const definition=read(file).match(new RegExp('create or replace function public\\.'+name+'\\([\\s\\S]*?(?:\\$function\\$|\\$\\$);','i'))[0];
    await db.exec(definition.replaceAll('public.',s+'.').replaceAll("'public'","'"+s+"'"));
   }
   await db.exec(`create trigger realtime_event_tickets_change after insert or update or delete on ${s}.event_tickets for each statement execute function ${s}.notify_admin_config_realtime_change();
    create trigger realtime_event_ticket_claims_member_record_change after insert or update or delete on ${s}.event_ticket_claims for each statement execute function ${s}.notify_member_record_realtime_change();
    create trigger realtime_calendar_items_change after insert or update or delete on ${s}.calendar_items for each statement execute function ${s}.notify_admin_config_realtime_change();`);
  }
  const repair=fs.readdirSync(dir).find(name=>name.endsWith('_effective_ticket_invalidation.sql'));
  if(repair&&read(repair).trim())await db.exec(read(repair));
  return{db,repair};
 }catch(error){await db.close();throw error;}
}
for(const schema of ['public',tenant])for(const table of ['event_tickets','event_ticket_claims','calendar_items']){
 test(`AC-REFRESH-002 ${schema}.${table}: zero-row and unchanged statements emit no invalidation; real bulk CRUD still emits once per scope`,async()=>{
  const {db}=await setup();const scopes=table==='calendar_items'?3:2;
  const count=async()=>Number((await db.query(`select count(*) n from ${schema}.realtime_events`)).rows[0].n);
  const clear=()=>db.exec(`truncate ${schema}.realtime_events`);
  try{
   await db.exec(`update ${schema}.${table} set status='expired' where false`);
   assert.equal(await count(),0,'maintenance that updates zero rows must not refresh any page');
   await db.exec(`insert into ${schema}.${table} values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A','active',now()),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B','active',now())`);
   assert.equal(await count(),scopes,'bulk insert emits once per original scope');await clear();
   await db.exec(`update ${schema}.${table} set title=title,updated_at=clock_timestamp()+interval '1 second'`);
   assert.equal(await count(),0,'timestamp-only changes do not alter user-visible ticket data');
   await db.exec(`update ${schema}.${table} set title='Changed'`);
   assert.equal(await count(),scopes);await clear();
   await db.exec(`begin;update ${schema}.${table} set status='used';rollback;`);
   assert.equal(await count(),0,'rolled-back changes do not publish events');
   await db.exec(`delete from ${schema}.${table}`);assert.equal(await count(),scopes);await clear();
   await db.exec(`delete from ${schema}.${table}`);assert.equal(await count(),0);
  }finally{await db.close();}
 });
}
test('AC-REFRESH-002: migration replay retains unrelated templates and provisions matching isolated triggers',async()=>{
 const {db,repair}=await setup();
 try{
  assert.ok(repair);await db.exec(read(repair));
  const tpl=(await db.query("select snapshot from platform_private.business_templates where version='business-v1-20261019'")).rows[0].snapshot;
  assert.equal(tpl.functions.find(f=>f.name==='unrelated').definition,'keep');
  assert.equal(tpl.triggers.find(t=>t.name==='unrelated').definition,'keep');
  assert.equal(tpl.triggers.filter(t=>t.name.startsWith('realtime_event_ticket')||t.name.startsWith('realtime_calendar_items')).length,9);
  assert.equal(tpl.functions.filter(f=>f.name==='notify_effective_ticket_invalidation').length,1);
  assert.equal((await db.query("select has_function_privilege('anon','public.notify_effective_ticket_invalidation()','execute') allowed")).rows[0].allowed,false);
  const fresh='business_'+'b'.repeat(32);
  await db.exec(`create schema ${fresh};create table ${fresh}.event_tickets(like public.event_tickets including all);
   create table ${fresh}.event_ticket_claims(like public.event_ticket_claims including all);
   create table ${fresh}.calendar_items(like public.calendar_items including all);
   create table ${fresh}.realtime_events(like public.realtime_events including all);`);
  const emitter=read('20260910_transactional_realtime_invalidation.sql').match(/create or replace function public\.emit_realtime_invalidation\([\s\S]*?\$function\$;/i)[0];
  await db.exec(emitter.replaceAll('public.',fresh+'.').replaceAll("'public'","'"+fresh+"'"));
  await db.exec(tpl.functions.find(f=>f.name==='notify_effective_ticket_invalidation').definition.replaceAll('public.',fresh+'.'));
  for(const trigger of tpl.triggers.filter(t=>t.name.startsWith('realtime_event_ticket')||t.name.startsWith('realtime_calendar_items')))await db.exec(trigger.definition.replaceAll('public.',fresh+'.'));
  await db.exec(`update ${fresh}.event_tickets set title='No rows';
   insert into ${fresh}.event_tickets values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','New','active',now());`);
  assert.equal(Number((await db.query(`select count(*) n from ${fresh}.realtime_events`)).rows[0].n),2);
  assert.equal(Number((await db.query('select count(*) n from public.realtime_events')).rows[0].n),0,'new tenant events do not leak into the public feed');
 }finally{await db.close();}
});

test('AC-REFRESH-004: actual fixed-ticket calendar sync does not invalidate unchanged or calendar-disabled runs',async()=>{
 const {db}=await setup();try{
  await db.exec(`create table public.fixed_ticket_templates(id uuid primary key,status text,calendar_enabled boolean,deleted_at timestamptz,schedule_type text);
   alter table public.event_tickets add starts_on date,add ends_on date,add deleted_at timestamptz,add description text,add accent text,add allowed_tier_keys text[],add event_ticket_id text;
   alter table public.calendar_items alter id set default gen_random_uuid(),add calendar_item_id text,add item_type text,add description text,add starts_on date,add ends_on date,add accent text,add allowed_tier_keys text[],add link_label text,add link_url text,add created_by text,add updated_by text,add source_event_ticket_id uuid,add audience_type text,add audience_month smallint;
   create unique index on public.calendar_items(source_event_ticket_id) where source_event_ticket_id is not null;
   create function public.new_public_id(text) returns text language sql as $$select $1||gen_random_uuid()::text$$;`);
  const snapshot=JSON.parse(read('20261019024033_business_runtime.sql').split('$business_template$')[1]);
  await db.exec(snapshot.functions.find(f=>f.name==='sync_fixed_ticket_calendar_item').definition);
  await db.exec(`insert into public.fixed_ticket_templates values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',false,null,'monthly');
   insert into public.event_tickets(id,title,status,starts_on,ends_on,event_ticket_id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','A','active','2026-11-01','2026-11-30','EVT-A');truncate public.realtime_events;`);
  const sync=()=>db.exec("select public.sync_fixed_ticket_calendar_item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')");
  const scopes=async()=>(await db.query('select scope from public.realtime_events order by scope')).rows.map(r=>r.scope);
  await sync();await sync();assert.deepEqual(await scopes(),[],'DELETE 0 from the actual producer cannot refresh a page');
  await db.exec('update public.fixed_ticket_templates set calendar_enabled=true');await sync();
  assert.deepEqual(await scopes(),['admin','calendar','member']);await db.exec('truncate public.realtime_events');
  await sync();assert.deepEqual(await scopes(),[],'the actual recurring UPSERT with identical content emits no events');
  await db.exec("update public.event_tickets set title='Changed';truncate public.realtime_events");await sync();
  assert.deepEqual(await scopes(),['admin','calendar','member'],'actual calendar edits retain every original consumer');
 }finally{await db.close();}
});
