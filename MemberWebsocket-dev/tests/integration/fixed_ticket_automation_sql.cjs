const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=name=>fs.readFileSync(path.join(__dirname,'../../supabase/migrations',name),'utf8');
const original=read('20260916220000_fixed_recurring_event_tickets.sql');
const migration=read('20261004051140_isolate_qa_fixed_ticket_automation.sql');

test('production fixed-ticket automation SQL',async t=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table members(id uuid primary key default gen_random_uuid(),line_user_id text unique,
        display_name text default 'QA',birthday date,status text default 'active',membership_status text default 'active',
        is_test_account boolean default false,joined_at timestamptz default now(),created_at timestamptz default now(),tier text default 'general');
      create table event_tickets(id uuid primary key default gen_random_uuid(),event_ticket_id text unique,title text,ticket_type text,
        description text,usage_method text,usage_instructions text,prizes jsonb,status text,starts_on date,ends_on date,
        quota integer,accent text,allowed_tier_keys text[],created_by text,updated_by text,activity_url text,activity_link_name text,
        deleted_at timestamptz,updated_at timestamptz default now());
      create table event_ticket_claims(id uuid primary key default gen_random_uuid(),claim_id text unique,event_ticket_id uuid,
        member_id uuid,ticket_type text,ticket_title text,ticket_description text,usage_method text,usage_instructions text,
        prizes jsonb,status text,claimed_at timestamptz,updated_at timestamptz,unique(event_ticket_id,member_id));
      create table scheduled_grant_messages(schedule_id text,request_id text unique,member_id uuid,line_user_id text,
        scheduled_for timestamptz,message_text text,status text,created_by text);
      create table audit_logs(audit_id text,actor_line_user_id text,actor_role text,action text,target_type text,target_id text,result text,detail jsonb);
      create table calendar_sync(template_id uuid,event_id uuid);
      create function sync_fixed_ticket_calendar_item(uuid,uuid) returns void language sql as $$ insert into calendar_sync values($1,$2) $$;
      create function current_tier_key(uuid) returns text language sql as $$ select tier from members where id=$1 $$;
      create function new_public_id(text) returns text language sql as $$ select $1||gen_random_uuid()::text $$;
    `);
    await db.exec(original.slice(0,original.indexOf('create or replace function public.issue_fixed_tickets')));
    await db.exec(`alter table fixed_ticket_templates add column expiry_mode text default 'month_end',add column expiry_date date,add column expiry_days integer default 7;`);
    await db.exec(migration);
    const value=async(sql,args=[])=> (await db.query(sql,args)).rows[0];
    const member=async(test=true,tier='general')=>(await value('insert into members(line_user_id,birthday,is_test_account,tier) values($1,$2,$3,$4) returning id',['fixture-'+crypto.randomUUID(),'1990-10-01',test,tier])).id;
    const template=async(schedule='birthday_month',expiry='month_end',qa=true,extra={})=>{
      const args=[crypto.randomUUID(),schedule,expiry,qa?'qa:e2e:isolated-fixture':'formal-admin',extra.quota||0,extra.day||31,extra.month||2,extra.weekday||1,extra.days||7,extra.expiryDate||'2027-12-31',extra.tiers||['general']];
      return (await value(`insert into fixed_ticket_templates(fixed_ticket_id,title,status,schedule_type,expiry_mode,created_by,updated_by,quota,
        schedule_day,schedule_month,schedule_weekday,expiry_days,expiry_date,allowed_tier_keys)
        values($1,'QA {year}/{month}','active',$2,$3,$4,$4,$5,case when $2 in ('monthly','yearly') then $6::smallint end,
        case when $2='yearly' then $7::smallint end,case when $2='weekly' then $8::smallint end,$9,$10,$11) returning id`,args)).id;
    };
    const issue=async(date,id,mid=null)=>(await value('select issue_fixed_tickets($1::date,$2::uuid,$3::uuid) result',[date,mid,id])).result;
    const event=async id=>value('select starts_on::text,ends_on::text,status from event_tickets where fixed_ticket_template_id=$1 order by starts_on desc limit 1',[id]);
    const reset=()=>db.exec('truncate members,event_tickets,event_ticket_claims,scheduled_grant_messages,audit_logs,calendar_sync,fixed_ticket_templates,fixed_ticket_grants cascade');

    await t.test('QA template grants only test accounts and never queues LINE notifications',async()=>{
      await reset();const qa=await member(),formal=await member(false),id=await template();
      assert.equal((await issue('2026-10-04',id)).issued,1);
      assert.deepEqual((await db.query('select member_id from fixed_ticket_grants')).rows,[{member_id:qa}]);
      assert.equal((await issue('2026-10-04',id,formal)).issued,0);
      assert.equal((await value('select count(*)::int n from scheduled_grant_messages')).n,0);
      assert.equal((await value('select count(*)::int n from calendar_sync')).n,2);
    });
    await t.test('birthday remains once per year after editing birth month; next year grants again',async()=>{
      await reset();const mid=await member(),id=await template();
      assert.equal((await issue('2026-10-04',id,mid)).issued,1);
      assert.equal((await issue('2026-10-05',id,mid)).issued,0);
      await db.query("update members set birthday='1990-11-01' where id=$1",[mid]);
      assert.equal((await issue('2026-11-01',id,mid)).issued,0);
      assert.equal((await issue('2027-11-01',id,mid)).issued,1);
      assert.equal((await value('select count(*)::int n from fixed_ticket_grants')).n,2);
    });
    await t.test('weekly, monthly and yearly cycles clamp dates and handle leap years',async()=>{
      await reset();const mid=await member();
      for(const [schedule,date,expected,extra] of [
        ['weekly','2026-10-04','2026-09-28',{weekday:1}],
        ['monthly','2026-02-28','2026-02-28',{day:31}],
        ['yearly','2028-02-29','2028-02-29',{day:29,month:2}]]) {
        const id=await template(schedule,'days_after_issue',true,extra);
        assert.equal((await issue(date,id,mid)).issued,1);
        assert.equal((await event(id)).starts_on,expected);
        assert.equal((await issue(date,id,mid)).issued,0);
      }
    });
    await t.test('all expiry modes produce inclusive dates and skip already expired templates',async()=>{
      await reset();const mid=await member();
      for(const [mode,expected,extra] of [
        ['month_end','2026-10-31',{}],['week_end','2026-10-11',{}],
        ['days_after_issue','2026-10-11',{days:7}],['fixed_date','2026-10-20',{expiryDate:'2026-10-20'}]]) {
        const id=await template('birthday_month',mode,true,extra);
        assert.equal((await issue('2026-10-05',id,mid)).issued,1);
        assert.equal((await event(id)).ends_on,expected);
      }
      assert.equal((await issue('2026-10-05',await template('birthday_month','fixed_date',true,{expiryDate:'2026-10-01'}),mid)).issued,0);
    });
    await t.test('quota and tier restrictions apply; formal accounts still receive production notifications',async()=>{
      await reset();await member();await member();await member(true,'gold');const formal=await member(false);
      const id=await template('birthday_month','month_end',true,{quota:1});
      assert.equal((await issue('2026-10-04',id)).issued,1);
      assert.equal((await issue('2026-10-04',id)).issued,0);
      const actual=await issue('2026-10-04',await template('birthday_month','month_end',false),formal);
      assert.equal(actual.issued,1);assert.equal(actual.queued,1);
      assert.equal((await value('select count(*)::int n from scheduled_grant_messages')).n,1);
    });
    await t.test('future scoped QA run cannot expire formal tickets or another member claim',async()=>{
      await reset();const qa=await member(),formal=await member(false);
      const actual=await template('birthday_month','month_end',false),isolated=await template();
      await issue('2026-10-04',actual,formal);await issue('2026-10-04',isolated,qa);
      await issue('2027-10-04',isolated,qa);
      assert.equal((await event(actual)).status,'active');
      assert.equal((await value('select status from event_ticket_claims where member_id=$1',[formal])).status,'claimed');
      assert.equal((await value("select status from event_ticket_claims where member_id=$1 order by claimed_at limit 1",[qa])).status,'expired');
      assert.equal((await value("select has_function_privilege('anon','issue_fixed_tickets(date,uuid,uuid)','execute') allowed")).allowed,false);
    });
  }finally{await db.close();}
});
