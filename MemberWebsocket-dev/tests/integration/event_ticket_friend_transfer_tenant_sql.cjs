const { PGlite }=require('@electric-sql/pglite');
const { readFileSync }=require('node:fs');
const { join }=require('node:path');
const assert=require('node:assert/strict');
const base=readFileSync(join(__dirname,'../../supabase/migrations/20261111122500_event_ticket_friend_transfer.sql'),'utf8');
const tenantPatch=readFileSync(join(__dirname,'../../supabase/migrations/20261111122600_event_ticket_friend_transfer_tenant.sql'),'utf8');
const giftPolicy=readFileSync(join(__dirname,'../../supabase/migrations/20261111134000_event_ticket_one_time_gift_tier_exemption.sql'),'utf8');
const schema='business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const A='00000000-0000-0000-0000-000000000001', B='00000000-0000-0000-0000-000000000002';
const E='10000000-0000-0000-0000-000000000001';
const db=new PGlite();
async function rejects(promise,code) {
  await assert.rejects(promise,error=>{assert.match(String(error),new RegExp(code));return true;});
}
async function run() {
  try {
    await db.exec("create role anon;create role authenticated;create role service_role");
    await db.exec([
      'create table public.members(id uuid primary key,line_user_id text unique not null,',
      "member_code text unique not null,status text not null default 'active',",
      "membership_status text not null default 'active',is_test_account boolean not null default false);",
      "create table public.event_tickets(id uuid primary key,event_ticket_id text unique not null,",
      "ticket_type text not null,status text not null default 'active',deleted_at timestamptz,",
      "ends_on date,fixed_ticket_template_id uuid,allowed_tier_keys text[] default array['general']);",
      "create table public.event_ticket_claims(id uuid primary key default gen_random_uuid(),",
      "claim_id text unique not null,event_ticket_id uuid not null references public.event_tickets(id),",
      "member_id uuid not null references public.members(id),status text not null,updated_at timestamptz default now(),",
      "unique(event_ticket_id,member_id));",
      "create table public.member_friendships(id uuid primary key default gen_random_uuid(),",
      "member_a uuid not null,member_b uuid not null,status text not null,unique(member_a,member_b));",
      "create table public.booking_benefit_selections(member_id uuid,benefit_kind text,benefit_ref text,status text);",
      "create table public.booking_receipts(member_id uuid,submission_mode text,status text,requested_benefits jsonb default '[]');",
      "create function public.current_tier_key(uuid) returns text language sql stable as $$select 'general'::text$$;",
    ].join('\n'));
    await db.exec(base);
    await db.exec('create schema '+schema);
    for(const table of ['members','event_tickets','event_ticket_claims','member_friendships','booking_benefit_selections','booking_receipts']){
      await db.exec('create table '+schema+'.'+table+'(like public.'+table+' including all)');
    }
    await db.exec("create function "+schema+".current_tier_key(uuid) returns text language sql stable as $$select 'general'::text$$;");
    await db.exec(tenantPatch);
    await db.exec(giftPolicy);
    assert.equal((await db.query("select to_regprocedure('"+schema+".transfer_event_ticket_to_friend(text,text,text,text)') is not null as available")).rows[0].available,true);
    assert.equal((await db.query("select relrowsecurity as protected from pg_class where oid=$1::regclass",[schema+'.event_ticket_transfers'])).rows[0].protected,true);
    for(const s of ['public',schema]){
      await db.query('insert into '+s+'.members(id,line_user_id,member_code) values ($1,$2,$3),($4,$5,$6)',
        [A,'actor-a','MEMBERA1',B,'actor-b','MEMBERB1']);
      await db.query("insert into "+s+".event_tickets(id,event_ticket_id,ticket_type) values ($1,$2,'coupon')",
        [E,s==='public'?'PUB-TICKET':'TENANT-TICKET']);
      await db.query("insert into "+s+".event_ticket_claims(claim_id,event_ticket_id,member_id,status) values ($1,$2,$3,'claimed')",
        [s==='public'?'PUB-CLAIM':'TENANT-CLAIM',E,A]);
    }
    await db.query('insert into '+schema+".member_friendships(member_a,member_b,status) values($1,$2,'accepted')",[A,B]);
    await rejects(db.query("select public.transfer_event_ticket_to_friend('actor-a','PUB-CLAIM','MEMBERB1','PUBLIC-REQUEST-1')"),'EVENT_TICKET_FRIEND_REQUIRED');
    await db.exec("update "+schema+".event_tickets set allowed_tier_keys=array['gold'] where event_ticket_id='TENANT-TICKET'");
    const res=await db.query("select "+schema+".transfer_event_ticket_to_friend('actor-a','TENANT-CLAIM','MEMBERB1','TENANT-REQUEST-1') as result");
    assert.equal(res.rows[0].result.claimId,'TENANT-CLAIM');
    assert.equal(res.rows[0].result.alreadyTransferred,false);
    const tenantOwner=(await db.query("select member_id::text from "+schema+".event_ticket_claims where claim_id='TENANT-CLAIM'")).rows[0].member_id;
    const publicOwner=(await db.query("select member_id::text from public.event_ticket_claims where claim_id='PUB-CLAIM'")).rows[0].member_id;
    assert.equal(tenantOwner,B,'tenant B (general tier) owns the gold-only claim');
    await rejects(db.query("select "+schema+".transfer_event_ticket_to_friend('actor-b','TENANT-CLAIM','MEMBERA1','TENANT-REQUEST-2')"),'EVENT_TICKET_FRIEND_REQUIRED');
    await db.query("insert into "+schema+".member_friendships(member_a,member_b,status) values($1,$2,'accepted') on conflict do nothing",[A,B]).catch(()=>{});
    await rejects(db.query("select "+schema+".transfer_event_ticket_to_friend('actor-b','TENANT-CLAIM','MEMBERA1','TENANT-REQUEST-3')"),'EVENT_TICKET_ALREADY_TRANSFERRED');
    assert.equal(publicOwner,A,'public claim does not change');
    await rejects(db.query("insert into "+schema+".event_ticket_claims(claim_id,event_ticket_id,member_id,status) values ('RECLAIM',$1,$2,'claimed')",[E,A]),'EVENT_TICKET_ALREADY_TRANSFERRED');
    assert.equal((await db.query("select has_function_privilege('anon', $1, 'EXECUTE') as value",[schema+'.transfer_event_ticket_to_friend(text,text,text,text)'])).rows[0].value,false);
    assert.equal((await db.query("select has_table_privilege('authenticated', $1, 'SELECT') as value",[schema+'.event_ticket_transfers'])).rows[0].value,false);
    console.log('isolated event friend-transfer tenant schema and ACL smoke: passed');
  } finally { await db.close(); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
