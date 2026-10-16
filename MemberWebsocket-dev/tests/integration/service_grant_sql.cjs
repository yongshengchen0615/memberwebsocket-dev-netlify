const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
test('service-item grants enforce canonical calculations, authorization and atomic rollback',async t=>{
  const db=await load();const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
  try {
    await db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations/20261008034343_admin_service_item_grants.sql'),'utf8'));
    await db.exec("insert into admins(line_user_id,role,status)values('test:grant-admin','admin','active');insert into members(line_user_id,member_code,status,membership_status,is_test_account)values('test:grant-member','GRANTQA','active','active',true);insert into booking_service_types(name)values('Grant QA');");
    const member=(await one("select id from members where line_user_id='test:grant-member'")).id;
    const card=(await one("insert into point_cards(card_id,title,status,created_by,updated_by)values('GRANT-CARD','QA grant card','active','test:grant-admin','test:grant-admin')returning id")).id;
    const type=(await one("select id from booking_service_types where name='Grant QA'")).id;
    await db.query('insert into booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point)values($1,$2,30)',[type,card]);
    const service=(await one("insert into booking_services(title,duration_minutes,service_type,is_active,counts_toward_membership,requires_companion_service,created_by)values('QA grant service',31,'Grant QA',true,true,false,'test:grant-admin')returning id")).id;
    const items=[{serviceId:service,quantity:2}];
    const preview=async(actor='test:grant-admin',values=items)=>(await one('select preview_service_member_grant($1,$2,$3) result',[actor,'test:grant-member',JSON.stringify(values)])).result;
    const grant=async(request,expected,values=items,actor='test:grant-admin')=>(await one('select grant_service_member_benefits($1,$2,$3,$4,$5) result',[actor,'test:grant-member',request,JSON.stringify(values),JSON.stringify(expected)])).result;
    const totals=async()=>({points:Number((await one('select coalesce(sum(amount),0)::int n from point_entries where member_id=$1',[member])).n),minutes:Number((await one('select coalesce(sum(minutes),0)::int n from service_time_entries where member_id=$1',[member])).n),requests:(await one('select count(*)::int n from service_grant_requests')).n});
    const expected=await preview();assert.equal(expected.serviceMinutes,62);assert.equal(expected.points[0].amount,2);
    await t.test('valid grant and exact replay apply once; conflicting replay rejects',async()=>{
      assert.equal((await grant('QA-SERVICE-GRANT-0001',expected)).applied,true);
      assert.equal((await grant('QA-SERVICE-GRANT-0001',expected)).alreadyApplied,true);
      await assert.rejects(grant('QA-SERVICE-GRANT-0001',expected,[{serviceId:service,quantity:1}]),/GRANT_REQUEST_CONFLICT/);
      assert.deepEqual(await totals(),{points:2,minutes:62,requests:1});
    });
    await t.test('invalid items, stale preview and unauthorized actor preserve both ledgers',async()=>{
      for(const values of [[],[{serviceId:service,quantity:0}],[{serviceId:service,quantity:3}],[{serviceId:service,quantity:'1'}],[{serviceId:service,quantity:1},{serviceId:service,quantity:1}]])await assert.rejects(preview('test:grant-admin',values));
      await assert.rejects(preview('test:grant-member'),/ADMIN_REQUIRED/);
      await assert.rejects(grant('QA-SERVICE-GRANT-0002',expected,items,'test:grant-member'),/ADMIN_REQUIRED/);
      await db.query('update booking_services set duration_minutes=60 where id=$1',[service]);
      await assert.rejects(grant('QA-SERVICE-GRANT-0002',expected),/SERVICE_GRANT_PREVIEW_STALE/);
      assert.deepEqual(await totals(),{points:2,minutes:62,requests:1});
    });
    await t.test('failure after ledger writes rolls back all changes including audit and request',async()=>{
      const fresh=await preview();
      const sideEffects=async()=>({balance:Number((await one('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card])).stamps),auditCount:(await one('select count(*)::int n from audit_logs')).n});
      const beforeSideEffects=await sideEffects();
      await db.exec("create function public.qa_reject_grant_request() returns trigger language plpgsql as $$ begin raise exception 'QA_WRITE_FAILURE'; end $$; create trigger qa_fail before insert on service_grant_requests for each row execute function public.qa_reject_grant_request();");
      await assert.rejects(grant('QA-SERVICE-GRANT-0003',fresh),/QA_WRITE_FAILURE/);
      assert.deepEqual(await totals(),{points:2,minutes:62,requests:1});
      assert.deepEqual(await sideEffects(),beforeSideEffects);
      await db.exec('drop trigger qa_fail on service_grant_requests;');
    });
    await t.test('client roles cannot call privileged grant RPC or read its request table',async()=>{
      for(const role of ['anon','authenticated']){
        await db.exec('set role '+role);await assert.rejects(preview(),/permission denied/);await assert.rejects(db.query('select * from service_grant_requests'),/permission denied/);await db.exec('reset role');
      }
    });
  } finally {await db.close();}
});
