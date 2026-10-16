const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migrations = path.join(__dirname, '../../supabase/migrations');
const member = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const booking = '30000000-0000-4000-8000-000000000001';
const version = '2026-10-03T00:00:00Z';

test('receipt replacement is atomic, owner scoped, replay safe, and preserves a valid snapshot on failure', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table members(id uuid primary key);
      create table bookings(id uuid primary key, member_id uuid references members, status text,
        cancellation_requested_at timestamptz, cancellation_reviewed_at timestamptz, updated_at timestamptz);
      create table audit_logs(audit_id text,actor_line_user_id text,actor_role text,action text,target_type text,target_id text,result text,detail jsonb);
      create table service_time_entries(member_id uuid, minutes integer);
      create function new_public_id(prefix text) returns text language sql as $$ select prefix||gen_random_uuid()::text $$;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],updated_at timestamptz);
      insert into members values ('${member}'),('${other}');
      insert into bookings values ('${booking}','${member}','confirmed',null,null,'${version}');
    `);
    const schema = fs.readFileSync(path.join(migrations, '20260930152500_booking_receipt_completion.sql'), 'utf8');
    await db.exec(schema.slice(0, schema.indexOf('create or replace function public.prepare_booking_receipt_request')) + 'commit;');
    await db.exec("alter table booking_receipts drop constraint booking_receipts_status_check; alter table booking_receipts add constraint booking_receipts_status_check check(status in ('pending_upload','awaiting_review','bound','failed','deleted')); create unique index booking_receipts_one_review_per_booking on booking_receipts(booking_id) where status='awaiting_review';");
    await db.exec(fs.readFileSync(path.join(migrations, '20261003074410_receipt_integrity_and_service_totals.sql'), 'utf8'));
    const prepare = async (key, owner = member, size = 100) => (await db.query('select prepare_booking_receipt_request($1,$2,$3,$4,$5,$6) as result', [booking, owner, key, `${owner}/${booking}/${key}.jpg`, 'image/jpeg', size])).rows[0].result;
    const finalize = async (id, owner = member, expected = version, size = 100) => (await db.query('select finalize_booking_receipt_request($1,$2,$3,$4,$5,$6,$7) as result', [id, owner, 'fixture', expected, 'image/jpeg', size, 'a'.repeat(64)])).rows[0].result;
    const current = async () => (await db.query("select receipt_id,object_path from booking_receipts where status='awaiting_review'")).rows;

    await assert.rejects(prepare('attempt-owner', other), /BOOKING_NOT_OWNED/);
    const first = await prepare('attempt-first');
    assert.equal((await prepare('attempt-first')).receiptId, first.receiptId);
    await assert.rejects(prepare('attempt-first', member, 101), /REQUEST_ID_CONFLICT/);
    await assert.rejects(finalize(first.receiptId, other), /RECEIPT_NOT_OWNED/);
    await finalize(first.receiptId);
    const original = await current();
    const second = await prepare('attempt-second');
    assert.notEqual(second.receiptId, first.receiptId);
    assert.notEqual(second.objectPath, first.objectPath);
    assert.deepEqual(await current(), original, 'Preparing must not remove the submitted snapshot');
    await assert.rejects(finalize(second.receiptId, member, version, 101), /RECEIPT_SIZE_MISMATCH/);
    await assert.rejects(finalize(second.receiptId, member, '2020-01-01T00:00:00Z'), /BOOKING_CONFLICT/);
    assert.deepEqual(await current(), original, 'Failed validation must preserve the submitted snapshot');
    await finalize(second.receiptId);
    assert.equal((await current())[0].receipt_id, second.receiptId);
    assert.equal((await db.query('select count(*)::int n from booking_receipt_cleanup_queue where object_path=$1', [first.objectPath])).rows[0].n, 1);
    assert.equal((await finalize(second.receiptId)).alreadyApplied, true);
    await assert.rejects(finalize(first.receiptId), /RECEIPT_NOT_PENDING/);
    assert.equal((await db.query('select count(*)::int n from audit_logs')).rows[0].n, 2, 'Repeated finalize must not add an audit/settlement');

    const abandoned = await prepare('attempt-abandoned');
    const replacement = await prepare('attempt-replacement');
    await assert.rejects(finalize(abandoned.receiptId), /RECEIPT_NOT_PENDING/);
    await assert.rejects(prepare('attempt-abandoned'), /RECEIPT_NOT_PENDING/);
    assert.deepEqual((await current()).map(row => row.receipt_id), [second.receiptId]);
    await db.exec("update bookings set status='completed';");
    await assert.rejects(finalize(replacement.receiptId), /INVALID_BOOKING_TRANSITION/);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role};`);
      await assert.rejects(prepare('attempt-denied'), /permission denied/);
      await assert.rejects(finalize(second.receiptId), /permission denied/);
      await db.exec('reset role;');
    }

    await db.exec(`insert into service_time_entries select '${member}',1 from generate_series(1,1501); insert into service_time_entries values ('${other}',999);`);
    const total = await db.query('select * from member_service_minute_totals($1)', [[member]]);
    assert.equal(total.rows.length, 1);
    assert.equal(Number(total.rows[0].total_minutes), 1501);
    assert.equal((await db.query('select * from member_service_minute_totals($1)', [[]])).rows.length, 0);
    await assert.rejects(db.query('select * from member_service_minute_totals($1)', [Array(101).fill(member)]), /INVALID_MEMBER_IDS/);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role};`);
      await assert.rejects(db.query('select * from member_service_minute_totals($1)', [[member]]), /permission denied/);
      await db.exec('reset role;');
    }
  } finally { await db.close(); }
});
