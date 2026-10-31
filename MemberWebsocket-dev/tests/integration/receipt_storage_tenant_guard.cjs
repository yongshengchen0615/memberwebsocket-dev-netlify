'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./fixtures/load-postgres-snapshot.cjs');

const migrations = path.resolve(__dirname, '../../supabase/migrations');
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '33333333-3333-4333-8333-333333333333';
const schemaA = 'business_' + tenantA.replace(/-/g, '');
const schemaB = 'business_' + tenantB.replace(/-/g, '');
const memberA = '22222222-2222-4222-8222-222222222222';
const memberB = '44444444-4444-4444-8444-444444444444';

test('AC-187-007: Storage guard authorizes real tenant members without bypassing deletion and isolation', async t => {
 const db = await load();
 const exec = name => db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
 const insert = async (bucket, objectPath) => db.query('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,objectPath]);
 try {
  for (const migration of [
    '20261006023020_booking_ticket_usage_consistency.sql',
    '20261006081433_booking_primary_requirement_fixed_notification_time.sql',
    '20261006133127_member_p2_features.sql',
    '20261008034343_admin_service_item_grants.sql',
    '20261008075553_single_active_member_login.sql',
    '20261008083358_test_account_duplicate_login_setting.sql',
    '20261008091007_test_login_takeover_single_session.sql',
    '20261005151234_e2e_membership_terms_scope.sql',
    '20261005152023_e2e_membership_terms_target_member.sql',
  ]) await exec(migration);
  await db.exec('create schema storage;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);');
  await exec('20261008152922_member_removal_workflow.sql');
  await db.exec(`
    create schema if not exists platform_private;
    create table platform_private.tenants(id uuid primary key, status text not null, runtime_schema text, expires_at timestamptz);
    create schema ${schemaA};create schema ${schemaB};
    create table ${schemaA}.members(id uuid primary key,status text not null);
    create table ${schemaB}.members(id uuid primary key,status text not null);
    create table ${schemaA}.member_removal_jobs(member_id uuid,state text);
    create table ${schemaB}.member_removal_jobs(member_id uuid,state text);
  `);
  await exec('20261019151200_fix_tenant_receipt_storage_guard.sql');
  await db.query('insert into platform_private.tenants(id,status,runtime_schema) values($1,\'active\',$2),($3,\'active\',$4)',[tenantA,schemaA,tenantB,schemaB]);
  await db.query(`insert into ${schemaA}.members(id,status) values ($1,'active')`,[memberA]);
  await db.query(`insert into ${schemaB}.members(id,status) values ($1,'active')`,[memberB]);
  const legacy = (await db.query(`insert into public.members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account)
    values('qa-tenant-receipt','AAAA','AAAA000000','active','active','QA Fixture',true) returning id`)).rows[0].id;
  // This must fail with MEMBER_REMOVED on the original one-segment-only guard.
  await t.test('valid active tenant upload succeeds; legacy and unrelated bucket remain usable', async () => {
    await insert('booking-receipts', tenantA + '/' + memberA + '/accessible/receipt.jpg');
    await insert('booking-receipts', tenantB + '/' + memberB + '/accessible/receipt.jpg');
    await insert('booking-receipts', legacy + '/accessible/receipt.jpg');
    await insert('e2e-failure-artifacts','unrelated/receipt.jpg');
  });
  await t.test('owner and tenant remain isolated', async () => {
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberB+'/accessible/wrong.jpg'),/MEMBER_REMOVED/);
    await assert.rejects(insert('booking-receipts',tenantB+'/'+memberA+'/accessible/wrong.jpg'),/MEMBER_REMOVED/);
    await assert.rejects(insert('booking-receipts','55555555-5555-4555-8555-555555555555/'+memberA+'/accessible/unknown.jpg'),/MEMBER_REMOVED/);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+legacy+'/accessible/wrong.jpg'),/MEMBER_REMOVED/);
  });
  await t.test('invalid paths fail closed', async () => {
    await assert.rejects(insert('booking-receipts',tenantA+'/invalid/accessible/bad.jpg'),/RECEIPT_OWNER_REQUIRED/);
    await assert.rejects(insert('booking-receipts','../'+memberA+'/bad.jpg'),/RECEIPT_OWNER_REQUIRED/);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberA),/RECEIPT_OWNER_REQUIRED/);
  });
  await t.test('deleting or disabled tenant members cannot create signed-upload metadata', async () => {
    await db.query(`insert into ${schemaA}.member_removal_jobs(member_id,state) values($1,'deleting')`,[memberA]);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberA+'/accessible/deleting.jpg'),/MEMBER_REMOVED/);
    await db.query(`delete from ${schemaA}.member_removal_jobs where member_id=$1`,[memberA]);
    await db.query(`update ${schemaA}.members set status='disabled' where id=$1`,[memberA]);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberA+'/accessible/disabled.jpg'),/MEMBER_REMOVED/);
    await db.query(`update ${schemaA}.members set status='active' where id=$1`,[memberA]);
  });
  await t.test('suspended, expired or unregistered tenants cannot sign', async () => {
    await db.query("update platform_private.tenants set status='suspended' where id=$1",[tenantA]);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberA+'/accessible/suspended.jpg'),/TENANT_NOT_ACTIVE/);
    await db.query("update platform_private.tenants set status='active',expires_at=now()-interval '1 day' where id=$1",[tenantA]);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberA+'/accessible/expired.jpg'),/TENANT_NOT_ACTIVE/);
    await db.query("update platform_private.tenants set expires_at=null,runtime_schema='public' where id=$1",[tenantA]);
    await assert.rejects(insert('booking-receipts',tenantA+'/'+memberA+'/accessible/foreign.jpg'),/TENANT_STORAGE_SCOPE_INVALID/);
  });
  const other = (await db.query('select count(*)::int n from storage.objects where bucket_id=\'booking-receipts\'')).rows[0].n;
  assert.equal(other, 3, 'only two tenant receipts and one legacy receipt were accepted');
 } finally { await db.close(); }
});
