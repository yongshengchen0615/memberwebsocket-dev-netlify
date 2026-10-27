const test = require('node:test');
const assert = require('node:assert/strict');
const database = require('./database.cjs');
const runtime = require('../business-runtime-fixture.cjs');

// Exercise the production tenant installers/RPCs in the disposable CI service.
// LINE verification is a separate Edge boundary; a DB pass cannot prove it.
let h;
const shops = [];
const lineUserId = 'U' + '6'.repeat(32);

test.before(async () => {
  h = await runtime(await database());
  try {
    for (const [index, slug] of ['member-race-a', 'member-race-b'].entries()) {
      const tenant = await h.approve('U' + String(index + 2).repeat(32), slug);
      const schema = tenant.runtime_schema;
      assert.match(schema, /^[a-z_][a-z0-9_]*$/);
      const terms = (await h.db.query(`
        insert into ${schema}.membership_terms
          (version,title,body,status,required,effective_at,activated_at,created_by,updated_by)
        values ('race-v1','Synthetic terms','Synthetic consent','active',true,
                now()-interval '1 day',now(),'fixture','fixture') returning id
      `)).rows[0].id;
      shops.push({ schema, terms });
    }
  } catch (error) {
    await h.db.close();
    h = null;
    throw error;
  }
});
test.after(async () => { if (h) await h.db.close(); });

async function pending(shop, user = lineUserId) {
  return (await h.db.query(`
    insert into ${shop.schema}.members
      (line_user_id,member_code,status,membership_status,is_test_account)
    values ($1,$2,'active','pending',false) returning id
  `, [user, 'MEM-' + crypto.randomUUID()])).rows[0].id;
}
function request(shop, user = lineUserId) {
  return {
    lineUserId: user, termsId: shop.terms, termsVersion: 'race-v1', accepted: true,
    birthday: '1990-01-01', phone: '+886912345678', surname: '林', salutation: 'mr',
  };
}
function accept(client, shop, payload, wrapper = true) {
  if (wrapper) return client.query(
    `select ${shop.schema}.accept_membership_terms_api($1::jsonb) joined`,
    [JSON.stringify(payload)],
  );
  return client.query(`
    select ${shop.schema}.accept_membership_terms($1,$2,$3,$4,$5,$6,$7,$8) joined
  `, [payload.lineUserId, payload.termsId, payload.termsVersion, payload.accepted,
      payload.birthday, payload.phone, payload.surname, payload.salutation]);
}
async function state(shop, member) {
  return (await h.db.query(`
    select membership_status,joined_at,
      (select count(*)::int from ${shop.schema}.membership_consents where member_id=m.id) consents,
      (select count(*)::int from ${shop.schema}.audit_logs
       where target_id=m.id::text and action='MEMBERSHIP_JOIN_CONSENT') activations
    from ${shop.schema}.members m where id=$1
  `, [member])).rows[0];
}
async function waitingOn(client, blocker) {
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  const blockerPid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual(pid, blockerPid, 'race must use two physical PostgreSQL sessions');
  return async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = (await h.db.query(`
        select $2::int = any(pg_blocking_pids($1::int)) blocked
      `, [pid, blockerPid])).rows[0];
      if (row.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('second registration did not wait for the first transaction');
  };
}

for (const firstWrapper of [true, false]) {
  test(`PostgreSQL 17 FJG02: ${firstWrapper ? 'payload' : 'legacy'} first and competing RPC activate once`, async () => {
    const shop = shops[0], user = 'U' + (firstWrapper ? '7' : '8').repeat(32);
    const member = await pending(shop, user), payload = request(shop, user);
    const writer = await h.db.connect(), reader = await h.db.connect();
    const wait = await waitingOn(reader, writer);
    await writer.query('set role service_role');
    await reader.query('set role service_role');
    let second;
    try {
      await writer.query('begin');
      assert.equal((await accept(writer, shop, payload, firstWrapper)).rows[0].joined, true);
      second = accept(reader, shop, payload, !firstWrapper);
      second.catch(() => {});
      await wait();
      // Uncommitted consent and activation must not leak into other sessions.
      assert.deepEqual(await state(shop, member), {
        membership_status: 'pending', joined_at: null, consents: 0, activations: 0,
      });
      await writer.query('commit');
      assert.equal((await second).rows[0].joined, false);
      const committed = await state(shop, member);
      assert.equal(committed.membership_status, 'active');
      assert.ok(committed.joined_at);
      assert.equal(committed.consents, 1);
      assert.equal(committed.activations, 1);
      // A later replay cannot change the first profile or join timestamp.
      assert.equal((await accept(reader, shop, {
        ...payload, surname: 'Changed', birthday: '1991-02-02',
        phone: '+886923456789', salutation: 'ms',
      })).rows[0].joined, false);
      assert.deepEqual(await state(shop, member), committed);
      assert.deepEqual((await h.db.query(`
        select birthday::text,phone,surname,salutation from ${shop.schema}.members where id=$1
      `, [member])).rows[0], {
        birthday: '1990-01-01', phone: '+886912345678', surname: '林', salutation: 'mr',
      });
      assert.equal((await h.db.query(`select count(*)::int n from ${shop.schema}.members where line_user_id=$1`, [user])).rows[0].n, 1);
    } finally {
      await writer.query('rollback');
      if (second) await second.catch(() => {});
    }
  });
}

test('PostgreSQL 17 FJG02: rolled-back registration lets the waiting request perform the only activation', async () => {
  const shop = shops[0], user = 'U' + '9'.repeat(32), member = await pending(shop, user);
  const writer = await h.db.connect(), reader = await h.db.connect();
  const wait = await waitingOn(reader, writer);
  await writer.query('set role service_role');
  await reader.query('set role service_role');
  let second;
  try {
    await writer.query('begin');
    assert.equal((await accept(writer, shop, request(shop, user))).rows[0].joined, true);
    second = accept(reader, shop, request(shop, user), false);
    second.catch(() => {});
    await wait();
    await writer.query('rollback');
    assert.equal((await second).rows[0].joined, true);
    const result = await state(shop, member);
    assert.equal(result.membership_status, 'active');
    assert.equal(result.consents, 1);
    assert.equal(result.activations, 1);
  } finally {
    await writer.query('rollback');
    if (second) await second.catch(() => {});
  }
});

test('PostgreSQL 17 FJG02: matching LINE users in two shops retain independent membership and consent', async () => {
  const [a, b] = shops, memberA = await pending(a), memberB = await pending(b);
  const client = await h.db.connect();
  await client.query('set role service_role');
  await assert.rejects(accept(client, a, { ...request(a), termsId: b.terms }), /TERMS_VERSION_STALE/);
  assert.deepEqual(await state(a, memberA), {
    membership_status: 'pending', joined_at: null, consents: 0, activations: 0,
  });
  assert.equal((await accept(client, a, request(a))).rows[0].joined, true);
  assert.deepEqual(await state(b, memberB), {
    membership_status: 'pending', joined_at: null, consents: 0, activations: 0,
  });
  const committedA = await state(a, memberA);
  assert.equal((await accept(client, b, request(b))).rows[0].joined, true);
  const committedB = await state(b, memberB);
  assert.equal(committedB.membership_status, 'active');
  assert.ok(committedB.joined_at);
  assert.equal(committedB.consents, 1);
  assert.equal(committedB.activations, 1);
  assert.deepEqual(await state(a, memberA), committedA);
});

test('PostgreSQL 17 FJG02: invalid consent, stale terms and incomplete profile persist no activation side effects', async () => {
  const shop = shops[0], user = 'U' + 'a'.repeat(32), member = await pending(shop, user);
  const client = await h.db.connect();
  await client.query('set role service_role');
  for (const [patch, error] of [
    [{ accepted: false }, /TERMS_CONSENT_REQUIRED/],
    [{ termsVersion: 'stale' }, /TERMS_VERSION_STALE/],
    [{ phone: 'invalid' }, /INVALID_PROFILE/],
  ]) {
    await assert.rejects(accept(client, shop, { ...request(shop, user), ...patch }), error);
    assert.deepEqual(await state(shop, member), {
      membership_status: 'pending', joined_at: null, consents: 0, activations: 0,
    });
  }
});

test('PostgreSQL 17 FJG02: direct service-role activation without consent is rejected by the real trigger', async () => {
  const shop = shops[0], user = 'U' + 'b'.repeat(32), member = await pending(shop, user);
  const client = await h.db.connect();
  await client.query('set role service_role');
  await assert.rejects(client.query(`
    update ${shop.schema}.members set membership_status='active' where id=$1
  `, [member]), /TERMS_CONSENT_REQUIRED/);
  assert.deepEqual(await state(shop, member), {
    membership_status: 'pending', joined_at: null, consents: 0, activations: 0,
  });
});

test('PostgreSQL 17 FJG02: anon and authenticated cannot call either tenant activation RPC', async () => {
  const shop = shops[0], user = 'U' + 'c'.repeat(32), member = await pending(shop, user);
  for (const role of ['anon', 'authenticated']) {
    const client = await h.db.connect();
    await client.query('set role ' + role);
    for (const wrapper of [true, false]) {
      await assert.rejects(accept(client, shop, request(shop, user), wrapper), /permission denied/);
    }
  }
  assert.deepEqual(await state(shop, member), {
    membership_status: 'pending', joined_at: null, consents: 0, activations: 0,
  });
});

async function referralMember(shop, digit, invite) {
  const user = 'U' + digit.repeat(32), member = await pending(shop, user);
  await accept(h.db, shop, request(shop, user));
  await h.db.query(`update ${shop.schema}.members set invite_code=$1 where id=$2`, [invite, member]);
  return { user, member, invite };
}
async function referralSource(shop, code) {
  await h.db.query(`update ${shop.schema}.event_tickets set status='draft'
    where ticket_type='referral' and referral_source_event_ticket_id is null`);
  return (await h.db.query(`insert into ${shop.schema}.event_tickets
    (event_ticket_id,title,ticket_type,status,quota,allowed_tier_keys,ends_on,created_by,updated_by)
    values ($1,'Synthetic referral','referral','active',1,array['general','silver','gold','platinum'],current_date+7,'fixture','fixture') returning id`, [code])).rows[0].id;
}
function bind(client, shop, actor, target, key) {
  return client.query(`select ${shop.schema}.bind_member_referral($1,$2,$3) result`, [actor.user, target.invite, key]);
}
async function rewardCounts(shop, source) {
  return (await h.db.query(`select
    (select count(*)::int from ${shop.schema}.member_referrals r join ${shop.schema}.event_tickets e on e.id=r.reward_event_ticket_id where e.referral_source_event_ticket_id=$1) relations,
    (select count(*)::int from ${shop.schema}.event_tickets where referral_source_event_ticket_id=$1) children,
    (select count(*)::int from ${shop.schema}.event_ticket_claims c join ${shop.schema}.event_tickets e on e.id=c.event_ticket_id where e.referral_source_event_ticket_id=$1) claims`, [source])).rows[0];
}

test('PostgreSQL 17 FJG02: concurrent referral replay issues one reward to the authenticated actor', async () => {
  const shop=shops[1], actor=await referralMember(shop,'d','D000000001'), target=await referralMember(shop,'e','E000000001');
  const source=await referralSource(shop,'QA-FJG-REPLAY');
  const writer=await h.db.connect(), reader=await h.db.connect(), wait=await waitingOn(reader,writer);
  await writer.query('set role service_role');await reader.query('set role service_role');
  let second;
  try {
    await writer.query('begin');
    const first=(await bind(writer,shop,actor,target,'QA-FJG-REFERRAL')).rows[0].result;
    assert.equal(first.alreadyApplied,false);
    second=bind(reader,shop,actor,target,'QA-FJG-REFERRAL');second.catch(()=>{});
    await wait();assert.deepEqual(await rewardCounts(shop,source),{relations:0,children:0,claims:0});
    await writer.query('commit');
    const replay=(await second).rows[0].result;
    assert.equal(replay.alreadyApplied,true);assert.equal(replay.referralId,first.referralId);
    assert.equal(replay.rewardEventTicketId,first.rewardEventTicketId);
    assert.deepEqual(await rewardCounts(shop,source),{relations:1,children:1,claims:1});
    const claim=(await h.db.query(`select c.member_id from ${shop.schema}.event_ticket_claims c join ${shop.schema}.event_tickets e on e.id=c.event_ticket_id where e.referral_source_event_ticket_id=$1`,[source])).rows;
    assert.deepEqual(claim,[{member_id:actor.member}]);
  } finally {await writer.query('rollback');if(second)await second.catch(()=>{});}
});

test('PostgreSQL 17 FJG02: competing referrals cannot exceed the remaining one-ticket quota', async () => {
  const shop=shops[1], actor=await referralMember(shop,'4','A000000004'), target=await referralMember(shop,'5','A000000005');
  const other=await referralMember(shop,'f','A000000006'), otherTarget=await referralMember(shop,'7','A000000007');
  const source=await referralSource(shop,'QA-FJG-QUOTA');
  const writer=await h.db.connect(), reader=await h.db.connect(), wait=await waitingOn(reader,writer);
  await writer.query('set role service_role');await reader.query('set role service_role');
  let second;
  try {
    await writer.query('begin');await bind(writer,shop,actor,target,'QA-FJG-FIRST-QUOTA');
    second=bind(reader,shop,other,otherTarget,'QA-FJG-SECOND-QUOTA');second.catch(()=>{});
    await wait();await writer.query('commit');
    await assert.rejects(second,/REFERRAL_REWARD_SOLD_OUT/);
    assert.deepEqual(await rewardCounts(shop,source),{relations:1,children:1,claims:1});
    assert.equal((await h.db.query(`select count(*)::int n from ${shop.schema}.member_referrals where inviter_member_id=$1 or invitee_member_id=$2`,[other.member,otherTarget.member])).rows[0].n,0);
  } finally {await writer.query('rollback');if(second)await second.catch(()=>{});}
});

test('PostgreSQL 17 FJG02: concurrent first-visit inserts leave one pending member available to the retry read', async () => {
  const shop=shops[1], user='U'+'8'.repeat(32), writer=await h.db.connect(), reader=await h.db.connect();
  const wait=await waitingOn(reader,writer);
  const sql=`insert into ${shop.schema}.members(line_user_id,member_code,status,membership_status,is_test_account) values($1,$2,'active','pending',false) returning id`;
  let second;
  try {
    await writer.query('begin');const first=(await writer.query(sql,[user,'QA-FJG-CREATE-FIRST'])).rows[0].id;
    second=reader.query(sql,[user,'QA-FJG-CREATE-SECOND']);second.catch(()=>{});
    await wait();await writer.query('commit');
    await assert.rejects(second,error=>error.code==='23505');
    const rows=(await reader.query(`select id,membership_status from ${shop.schema}.members where line_user_id=$1`,[user])).rows;
    assert.deepEqual(rows,[{id:first,membership_status:'pending'}]);
    assert.deepEqual(await state(shop,first),{membership_status:'pending',joined_at:null,consents:0,activations:0});
  } finally {await writer.query('rollback');if(second)await second.catch(()=>{});}
});
