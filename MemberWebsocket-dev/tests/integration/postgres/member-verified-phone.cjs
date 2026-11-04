const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const database = require('./database.cjs');
const fixture = require('../business-runtime-fixture.cjs');

const migration = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/20261104160600_member_verified_phone_binding.sql'), 'utf8');
const owner = 'U' + '8'.repeat(32);
const memberA = 'U' + 'a'.repeat(32);
const memberB = 'U' + 'b'.repeat(32);
const signature = '(text,text,timestamp with time zone,jsonb)';
const newPhone = '+886923456789';

async function termsFor(h, schema) {
  const row = await h.db.query(
    'insert into '+schema+".membership_terms(version,title,body,status,required,effective_at,activated_at,created_by,updated_by) values ('phone-v1','QA terms','Synthetic acceptance','active',true,now()-interval '1 day',now(),'fixture','fixture') returning id"
  );
  return row.rows[0].id;
}

async function seedActive(h, schema, actor, code, phone, termsId) {
  const member = await h.db.query(
    'insert into '+schema+".members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values ($1,'QA member',$2,'pending','active',false) returning id",
    [actor,code]
  );
  const payload = {
    lineUserId: actor, termsId, termsVersion: 'phone-v1', accepted: true,
    birthday: '1990-01-01', surname: '林', salutation: 'mr', phone,
  };
  const accepted = await h.db.query(
    'select '+schema+'.accept_membership_terms_api($1::jsonb) accepted',[JSON.stringify(payload)]
  );
  assert.equal(accepted.rows[0].accepted, true);
  return (await h.db.query('select id,updated_at from '+schema+'.members where id=$1',[member.rows[0].id])).rows[0];
}

test('AC-001/002/003: verified-phone columns, trigger, unique ownership and tenant privileges', async () => {
  const h = await fixture({ ...await database() });
  try {
    const tenant = await h.approve(owner, 'verified-phone-' + crypto.randomUUID().slice(0, 8));
    const schema = tenant.runtime_schema;
    await h.db.exec(migration);
    // Idempotent migration must not corrupt existing profile state.
    await h.db.exec(migration);

    const cols = (await h.db.query(
      "select column_name from information_schema.columns where table_schema=$1 and table_name='members' and column_name in ('phone_verified_e164','phone_verified_at')",
      [schema]
    )).rows.map(row => row.column_name).sort();
    assert.deepEqual(cols, ['phone_verified_at','phone_verified_e164']);
    const privilege = (await h.db.query(
      "select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",
      [schema + '.member_commit_verified_phone' + signature]
    )).rows[0];
    assert.deepEqual(privilege, { anon: false, authenticated: false, service: true });

    const terms=await termsFor(h,schema);
    const a=await seedActive(h,schema,memberA,'VERIFIED-A','+886912345678',terms);
    const b=await seedActive(h,schema,memberB,'VERIFIED-B','+886936789012',terms);
    const action = 'select ' + schema + '.member_commit_verified_phone($1,$2,$3,$4) row';
    const success = await h.db.query(action, [memberA,newPhone,a.updated_at,null]);
    assert.equal(success.rows[0].row.phone_verified_e164,newPhone);
    assert.ok(success.rows[0].row.phone_verified_at);
    assert.equal((await h.db.query('select count(*)::int n from ' + schema + ".audit_logs where action='MEMBER_PHONE_VERIFIED'")).rows[0].n,1);
    await assert.rejects(
      h.db.query(action, [memberB,newPhone,b.updated_at,null]),
      /members_verified_phone_unique|duplicate key/i
    );
    assert.equal((await h.db.query('select phone from '+schema+'.members where id=$1',[b.id])).rows[0].phone,'+886936789012');

    // A legacy edit must invalidate the bound number, not transfer verification to a new value.
    await h.db.query('update '+schema+'.members set phone=$1 where id=$2',['+886934567890',a.id]);
    const cleared=(await h.db.query('select phone,phone_verified_e164,phone_verified_at from '+schema+'.members where id=$1',[a.id])).rows[0];
    assert.equal(cleared.phone,'+886934567890');
    assert.equal(cleared.phone_verified_e164,null);
    assert.equal(cleared.phone_verified_at,null);

    // When the original number is released, another account can bind it.
    const bound = await h.db.query(action,[memberB,newPhone,b.updated_at,null]);
    assert.equal(bound.rows[0].row.phone_verified_e164,newPhone);
  } finally { await h.db.close(); }
});

test('AC-004: simultaneous verified claims are serialized by the unique index', async () => {
  const h = await fixture({ ...await database() });
  try {
    const tenant=await h.approve(owner,'verified-race-'+crypto.randomUUID().slice(0,8));
    const schema=tenant.runtime_schema;
    await h.db.exec(migration);
    const terms=await termsFor(h,schema);
    const a=await seedActive(h,schema,memberA,'RACE-A','+886912345678',terms);
    const b=await seedActive(h,schema,memberB,'RACE-B','+886936789012',terms);
    const c1=await h.db.connect(),c2=await h.db.connect();
    const sql='select '+schema+'.member_commit_verified_phone($1,$2,$3,$4) row';
    const outcomes=await Promise.allSettled([
      c1.query(sql,[memberA,newPhone,a.updated_at,null]),
      c2.query(sql,[memberB,newPhone,b.updated_at,null]),
    ]);
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(o=>o.status==='rejected'&&/members_verified_phone_unique|duplicate key/i.test(o.reason.message)).length,1);
    const state=(await h.db.query('select count(*)::int n from '+schema+'.members where phone_verified_e164=$1',[newPhone])).rows[0];
    assert.equal(state.n,1);
    assert.equal((await h.db.query('select count(*)::int n from '+schema+".audit_logs where action='MEMBER_PHONE_VERIFIED'")).rows[0].n,1);
  } finally { await h.db.close(); }
});

test('AC-005: merchant created after migration inherits verified-phone schema and RPC', async () => {
  const h=await fixture({ ...await database() });
  try {
    await h.db.exec(migration);
    const tenant=await h.approve(owner,'future-phone-'+crypto.randomUUID().slice(0,8));
    const schema=tenant.runtime_schema;
    const cols=(await h.db.query("select column_name from information_schema.columns where table_schema=$1 and table_name='members' and column_name='phone_verified_at'",[schema])).rows;
    assert.equal(cols.length,1);
    assert.ok((await h.db.query('select to_regprocedure($1) fn',[schema+'.member_commit_verified_phone'+signature])).rows[0].fn);
    assert.equal((await h.db.query("select count(*)::int n from pg_indexes where schemaname=$1 and tablename='members' and indexname='members_verified_phone_unique'",[schema])).rows[0].n,1);
  } finally { await h.db.close(); }
});
