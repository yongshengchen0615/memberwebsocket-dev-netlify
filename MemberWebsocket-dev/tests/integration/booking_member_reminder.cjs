const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261031090000_member_booking_reminder_choice.sql'), 'utf8');
const memberId = '10000000-0000-4000-8000-000000000001';
const memberLine = 'U' + 'a'.repeat(32);

test('booking reminder SQL migration: atomic preferences, idempotency, opt-out and dispatch gate', async t => {
  const db = new PGlite();
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const one = async (sql, params = []) => (await rows(sql, params))[0];
  try {
    await db.exec(`
create role anon;
create role authenticated;
create role service_role;
create schema booking_notifications;
create table public.members(id uuid primary key, line_user_id text, is_test_account boolean not null default false);
create table public.booking_settings(id integer primary key, reminder_enabled boolean not null default false, reminder_time time not null default '18:00');
create table public.bookings(
  id uuid primary key default gen_random_uuid(), request_id text unique not null,
  member_id uuid references public.members(id), status text not null default 'confirmed',
  start_at timestamp without time zone, cancellation_requested_at timestamptz
);
create table booking_notifications.config(id boolean primary key default true, enabled boolean not null);
create table booking_notifications.outbox(
  id uuid primary key default gen_random_uuid(), booking_id uuid not null,
  event_key text not null, channel text, recipient text, message_text text,
  reminder_start_at timestamp without time zone, next_attempt_at timestamptz,
  status text not null default 'pending', attempt_count integer not null default 0,
  first_attempt_at timestamptz, last_error text
);
create unique index outbox_day_before_reminder_once
  on booking_notifications.outbox(event_key) where event_key ~ ':reminder:day_before$';
insert into public.members(id,line_user_id) values ('${memberId}', '${memberLine}');
insert into public.booking_settings(id,reminder_enabled,reminder_time) values (1,true,'14:30');
insert into booking_notifications.config(id,enabled) values (true,true);
insert into public.bookings(request_id,member_id,start_at)
  values ('BOOK-before-migration', '${memberId}',
   (now() at time zone 'Asia/Taipei')::date + interval '3 days 10 hours');
create function public.create_booking_bundle_with_benefits_request(
  p_request_id text, p_member_id uuid, p_booking_date date, p_start_time time,
  p_items jsonb, p_member_note text, p_benefits jsonb
) returns public.bookings language plpgsql as $stub$
declare result public.bookings;
begin
  select * into result from public.bookings where request_id = p_request_id;
  if found then return result; end if;
  insert into public.bookings(request_id,member_id,status,start_at)
    values(p_request_id,p_member_id,'confirmed',p_booking_date + p_start_time)
    returning * into result;
  return result;
end $stub$;
`);
    await db.exec(migration);
    const tomorrow = (await one("select ((now() at time zone 'Asia/Taipei')::date + 1)::text d")).d;
    const future = (await one("select ((now() at time zone 'Asia/Taipei')::date + 3)::text d")).d;
    const call = (key, enabled, time, date = future) => db.query(
      'select (public.create_booking_bundle_with_benefits_reminder($1,$2,$3,$4,$5,$6,$7,$8,$9)).*',
      [key, memberId, date, '10:00', '[]', '', '[]', enabled, time]
    );

    await t.test('existing confirmed reservations inherit prior settings; new reservations start opted out', async () => {
      const historic = await one("select reminder_enabled,reminder_time::text from public.bookings where request_id='BOOK-before-migration'");
      assert.equal(historic.reminder_enabled, true);
      assert.match(historic.reminder_time, /^14:30/);
      const created = (await call('BOOK-remind-off-01', false, '18:00')).rows[0];
      assert.equal(created.reminder_enabled, false);
      assert.match(created.reminder_time, /^18:00/);
    });

    let active;
    await t.test('enabled consent persists; identical retries are idempotent and changed retry is rejected', async () => {
      active = (await call('BOOK-remind-on-01', true, '20:15')).rows[0];
      assert.equal(active.reminder_enabled, true);
      assert.match(active.reminder_time, /^20:15/);
      assert.equal((await call('BOOK-remind-on-01', true, '20:15')).rows[0].id, active.id);
      await assert.rejects(call('BOOK-remind-on-01', false, '20:15'), /REQUEST_ID_CONFLICT/);
      assert.equal((await one("select count(*)::int n from public.bookings where request_id='BOOK-remind-on-01'")).n, 1);
    });

    await t.test('invalid seconds and late day-before time roll back the booking creation', async () => {
      await assert.rejects(call('BOOK-remind-bad-01', true, '19:00:01'), /INVALID_BOOKING_REMINDER/);
      await assert.rejects(call('BOOK-remind-late-01', true, '00:00', tomorrow), /REMINDER_TIME_PASSED/);
      assert.equal((await one("select count(*)::int n from public.bookings where request_id like 'BOOK-remind-bad-%' or request_id like 'BOOK-remind-late-%'")).n, 0);
    });

    await t.test('sync respects each booking time and ignores old global flag', async () => {
      await db.exec("update public.booking_settings set reminder_enabled=false,reminder_time='07:00' where id=1");
      await rows("update public.bookings set start_at = $1::date + time '10:00',reminder_time='00:00' where id=$2", [tomorrow, active.id]);
      await db.query("select booking_notifications.sync_day_before_reminders()");
      const queued = await one('select * from booking_notifications.outbox where booking_id=$1', [active.id]);
      assert.equal(queued.status, 'pending');
      assert.ok(queued.next_attempt_at, 'scheduled timestamp must be present');
      assert.match(queued.message_text, /預約提醒/);
    });

    await t.test('dispatch re-check permits due reminder but suppresses a subsequently opted-out booking', async () => {
      const queued = await one('select id from booking_notifications.outbox where booking_id=$1', [active.id]);
      await rows("update booking_notifications.outbox set status='sending',attempt_count=1 where id=$1", [queued.id]);
      assert.equal((await one('select public.skip_invalid_booking_reminder($1,1) valid', [queued.id])).valid, false);
      await rows('update public.bookings set reminder_enabled=false where id=$1', [active.id]);
      assert.equal((await one('select public.skip_invalid_booking_reminder($1,1) suppressed', [queued.id])).suppressed, true);
      assert.equal((await one('select status from booking_notifications.outbox where id=$1', [queued.id])).status, 'skipped');
    });
  } finally {
    await db.close();
  }
});
