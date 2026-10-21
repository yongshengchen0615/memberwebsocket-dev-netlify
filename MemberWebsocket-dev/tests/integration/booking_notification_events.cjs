const {test}=require('node:test'),assert=require('node:assert/strict');
const setup=require('./fixtures/booking-event-setup.cjs');
const owner='U'+'2'.repeat(32),memberLine='U'+'3'.repeat(32);
test('AC-188: commit routes create to admin, confirm/edit to member and suppresses no-op technician edits',async()=>{
 const h=await setup();try{
  const b=await h.make();let rows=await h.q('select * from S.notice_outbox where booking_id=$1',[b]);
  assert.equal(rows.length,1);assert.equal(rows[0].channel,'admin');assert.equal(rows[0].recipient,owner);assert.ok(rows[0].event_key.endsWith(':created'));
  await h.q("update S.bookings set status='confirmed' where id=$1",[b]);
  rows=await h.q('select * from S.notice_outbox where booking_id=$1',[b]);assert.equal(rows.length,2);assert.equal(rows.find(r=>r.channel==='member').recipient,memberLine);
  const edit=async tech=>h.q('select S.admin_update_booking_participant_technicians_request($1,$2,$3,$4)',[b,(await h.state(b)).updated_at,owner,[{position:1,technicianId:tech}]]);
  await edit(h.tech);
  rows=await h.q("select * from S.notice_outbox where booking_id=$1 and coalesce_key is not null",[b]);
  assert.equal(rows.length,1,'effective technician change must notify the member');assert.equal(rows[0].channel,'member');assert.ok(rows[0].message_text.includes('QA technician'));
  const version=(await h.state(b)).updated_at;
  await edit(h.tech);assert.equal(String((await h.state(b)).updated_at),String(version),'no-op must not change version or notify');
  await h.q('select S.admin_update_booking_participant_items_request($1,$2,$3,$4)',[b,version,owner,[{position:1,items:[{serviceId:h.svc,quantity:1}]}]]);
  assert.equal(String((await h.state(b)).updated_at),String(version),'no-op services preserve booking version');
  await h.q('select S.admin_update_booking_participant_items_request($1,$2,$3,$4)',[b,version,owner,[{position:1,items:[{serviceId:h.svc,quantity:2}]}]]);
  assert.equal((await h.q('select quantity from S.booking_participant_items where service_id=$1',[h.svc]))[0].quantity,2);
  await h.q("update S.bookings set status='cancelled',cancelled_by=$2 where id=$1",[b,owner]);
  assert.equal((await h.q("select count(*)::int n from S.notice_outbox where booking_id=$1 and channel='member' and message_text like '【預約取消】%'",[b]))[0].n,1);
 }finally{await h.db.close();}
});
test('AC-188: rollback and unauthorized changes leave booking and notification data unchanged',async()=>{
 const h=await setup();try{
  const b=await h.make(),version=(await h.state(b)).updated_at;
  await assert.rejects(h.q('select S.admin_update_booking_participant_technicians_request($1,$2,$3,$4)',[b,version,memberLine,[{position:1,technicianId:h.tech}]]),/ADMIN_REQUIRED/);
  await h.db.exec('begin');await h.q("update S.bookings set status='confirmed' where id=$1",[b]);await h.db.exec('rollback');
  assert.equal((await h.state(b)).status,'pending');assert.equal((await h.q('select count(*)::int n from S.notice_outbox where booking_id=$1',[b]))[0].n,1);
 }finally{await h.db.close();}
});
test('AC-188: post-commit wake uses tenant scope; durable claims, backoff and stale workers cannot duplicate effects',async()=>{
 const h=await setup();try{
  const b=await h.make();
  await h.db.exec(`create schema net;create table net.calls(body jsonb);create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)returns bigint language plpgsql as $$begin insert into net.calls values(body);return 1;end$$;insert into vault.decrypted_secrets(name,decrypted_secret,updated_at)values('project_url','https://synthetic.invalid',now()),('BOOKING_NOTIFICATION_DISPATCH_SECRET','synthetic-dispatch',now());`);
  const wake=async()=>(await h.db.query('select public.platform_dispatch_booking($1) sent',[h.t.id])).rows[0].sent;
  assert.equal(await wake(),false,'unconfigured route stays closed');
  await h.db.query("update platform_private.tenants set module_line='{\"booking\":{\"notifications\":{\"admin\":{\"mode\":\"custom\"}}}}' where id=$1",[h.t.id]);
  assert.equal(await wake(),true);assert.equal((await h.db.query('select * from net.calls')).rows[0].body.business,h.t.slug);
  const claim=async()=>h.q('select * from S.claim_booking_notifications(20)');const first=await claim();assert.equal(first.length,1);assert.equal((await claim()).length,0,'lease prevents immediate duplicate claiming');
  const job=first[0];await h.q('select S.finish_booking_notification($1,$2,false,true,429,\'synthetic-request\')',[job.id,job.attempt_count]);
  const retry=(await h.q('select * from S.notice_outbox where id=$1',[job.id]))[0];assert.equal(retry.status,'pending');assert.equal(retry.id,job.id);assert.ok(retry.next_attempt_at>retry.created_at);
  assert.equal((await h.q("select S.finish_booking_notification($1,$2,true,false,200,'stale') done",[job.id,job.attempt_count]))[0].done,false);
  await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[h.t.id]);assert.equal(await wake(),false);
  for(const role of ['anon','authenticated']){await h.db.exec('set role '+role);await assert.rejects(wake(),/permission denied/);await h.db.exec('reset role');}
  assert.equal((await h.state(b)).status,'pending');
 }finally{await h.db.close();}
});
