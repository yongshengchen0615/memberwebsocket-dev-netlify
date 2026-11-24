const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./business-platform-fixture.cjs');

const owner = 'U' + '2'.repeat(32);
const memberActor = 'U' + '3'.repeat(32);
const intruder = 'U' + '5'.repeat(32);
const staff = 'U' + '4'.repeat(32);
const channel = '2010999999';
const migrations = path.join(__dirname, '../../supabase/migrations');

async function migration(db, filename) {
  await db.exec(fs.readFileSync(path.join(migrations, filename), 'utf8'));
}

// Install the exact paired-insert guard contracts from their earlier migrations
// into a tenant already provisioned by this isolated suite. The actual release
// sequence installed these before the new direct-cancel migration. Rebuilding
// notice_enqueue from the generic template would erase both guards.
async function installExistingPairedNoticeGuards(db, schema) {
  for (const [filename, name] of [
    ['20261121120000_frontdesk_rejection_line_details.sql', 'frontdesk_paired_phone_source'],
    ['20261122183000_admin_rejection_frontdesk_line_scope.sql', 'admin_paired_walkin_source'],
  ]) {
    const sql = fs.readFileSync(path.join(migrations, filename), 'utf8');
    const start = sql.indexOf('create or replace function platform_private.' + name + '(');
    const revoke = sql.indexOf('revoke all on function platform_private.' + name + '(', start);
    const end = sql.indexOf(';', revoke);
    assert.ok(start >= 0 && revoke > start && end > revoke, 'production guard source exists: ' + name);
    await db.exec(sql.slice(start, end + 1));
  }
  const getDefinition = async () => (await db.query(
    "select pg_get_functiondef(to_regprocedure(format('%I.notice_enqueue()', $1::text))) as definition",
    [schema],
  )).rows[0].definition;
  const original = await getDefinition();
  const marker = "begin\n  if TG_OP = 'INSERT' then";
  assert.equal(original.split(marker).length - 1, 1, 'tenant INSERT guard anchor is unique');
  const guarded = original.replace(marker, `begin
  if TG_OP = 'INSERT' and
     (platform_private.frontdesk_paired_phone_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null
       or platform_private.admin_paired_walkin_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null)
    then return null;end if;
  if TG_OP = 'INSERT' then`);
  await db.exec(guarded);
  const installed = await getDefinition();
  assert.match(installed, /platform_private\.frontdesk_paired_phone_source\(TG_TABLE_SCHEMA/);
  assert.match(installed, /platform_private\.admin_paired_walkin_source\(TG_TABLE_SCHEMA/);
  return getDefinition;
}

test('AC-002..004, AC-007: direct cancellation is tenant-authorized, atomic and idempotent', async () => {
  const h = await fixture();
  try {
    const tenant = await h.approve(owner, 'cancel-desk-shop');
    const schema = tenant.runtime_schema;
    const q = async (sql, args = []) => (await h.db.query(sql.replaceAll('S.', schema + '.'), args)).rows;
    const invoke = async (name, args) =>
      (await h.db.query('select public.' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') result', args)).rows[0].result;

    // Reuse the complete, real frontdesk deployment prerequisites from the
    // existing isolated integration suite. No real member or service is used.
    await h.db.exec('alter table ' + schema + ".booking_participants add column if not exists member_note text not null default ''");
    await migration(h.db, '20261026050904_line_webhook.sql');
    await migration(h.db, '20261118122150_frontdesk_booking_access.sql');
    await migration(h.db, '20261118190000_frontdesk_safeupdate_projection.sql');
    await migration(h.db, '20261119150000_frontdesk_independent_feature_grant.sql');
    await migration(h.db, '20261120114500_frontdesk_line_booking_details.sql');
    await migration(h.db, '20261120143000_frontdesk_sync_admin_confirmation.sql');
    await migration(h.db, '20261120170000_frontdesk_confirm_line_individual_totals.sql');
    const installedNoticeDefinition = await installExistingPairedNoticeGuards(h.db, schema);
    await migration(h.db, '20261124175200_frontdesk_direct_member_cancellation.sql');
    const retainedDefinition = await installedNoticeDefinition();
    assert.match(retainedDefinition, /platform_private\.frontdesk_paired_phone_source\(TG_TABLE_SCHEMA/,
      'existing frontdesk paired-rejection suppression survives direct-cancel migration');
    assert.match(retainedDefinition, /platform_private\.admin_paired_walkin_source\(TG_TABLE_SCHEMA/,
      'existing admin paired-rejection suppression survives direct-cancel migration');
    assert.match(retainedDefinition, /cancellation_reviewed_by = 'system:frontdesk'/,
      'direct-cancellation fanout is added without replacing the guards');

    const member = (await q(
      "insert into S.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account) values($1,'CANCEL-M','ABCD654321','active','active',true) returning id",
      [memberActor]))[0].id;
    await q('update S.members set is_test_account=false where id=$1', [member]);
    await q("update S.booking_settings set require_primary_technician=false,work_start_time='08:00',work_end_time='22:00'");
    await q("insert into S.booking_service_types(name)values('CANCEL-TYPE')");
    const service = (await q(
      "insert into S.booking_services(title,duration_minutes,price_amount,service_type,created_by) values('CANCEL SERVICE',30,100,'CANCEL-TYPE',$1) returning id",
      [owner]))[0].id;
    const makeBooking = async () => (await q(
      "select (S.create_group_booking_request_v2($1,$2,current_date+3,'10:00',$3,'')).id id",
      ['CANCEL-' + crypto.randomUUID(), member, [{ technicianId: null, items: [{ serviceId: service, quantity: 1 }] }]]
    ))[0].id;
    const callCancel = (booking, actor = memberActor, memberId = member, tenantId = tenant.id, revision = null) =>
      invoke('platform_member_direct_cancel_booking', [tenantId, booking, memberId, actor, revision]);

    let booking = await makeBooking();
    await assert.rejects(callCancel(booking), /FRONTDESK_UNAVAILABLE/,
      'no super-admin grant cannot be used to cancel directly');

    await h.db.query("update platform_private.tenants set features=features||'{\"frontdesk\":true}'::jsonb where id=$1", [tenant.id]);
    await assert.rejects(callCancel(booking), /FRONTDESK_DIRECT_CANCELLATION_DISABLED/,
      'grant alone is insufficient without a configured merchant frontdesk');

    const config = { loginChannelId: channel, liffId: channel + '-desk', messagingChannelId: '2010888888',
      oaId: '@desk', enabled: true, expectedVersion: 1,
      envelope: { version: 1, iv: 'a'.repeat(16), data: 'b'.repeat(48) } };
    const admin = (action, body = {}) => invoke('platform_frontdesk_admin',
      [owner, tenant.id, new Date().toISOString(), action,
        { requestId: crypto.randomUUID(), payloadHash: 'a'.repeat(64), ...body }]);
    const req = (action, body = {}) => invoke('platform_frontdesk_request',
      [tenant.id, staff, channel, new Date().toISOString(), action, body]);
    await admin('settings.save', config);
    await req('apply', { displayName: '櫃檯同仁', oaVerified: true,
      verifiedMessagingChannelId: '2010888888', verifiedConfigRevision: 2 });
    const staffRecord = (await admin('get')).staff[0];
    await admin('staff.save', {
      staffId: staffRecord.id, expectedVersion: staffRecord.version,
      status: 'approved', permissionMode: 'notify_only',
    });

    const before = (await q('select * from S.bookings where id=$1', [booking]))[0];
    await assert.rejects(callCancel(booking, intruder), /MEMBERSHIP_REQUIRED/,
      'another LINE principal cannot claim the member identity');
    await assert.rejects(callCancel(booking, memberActor, crypto.randomUUID()), /MEMBERSHIP_REQUIRED/,
      'an unrelated member id cannot be used');
    await assert.rejects(callCancel(booking, memberActor, member, tenant.id, new Date(0).toISOString()),
      /BOOKING_CONFLICT/, 'stale cancellation revision must be rejected');

    const result = await callCancel(booking, memberActor, member, tenant.id, before.updated_at);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.alreadyCancelled, false);
    const after = (await q('select * from S.bookings where id=$1', [booking]))[0];
    assert.equal(after.status, 'cancelled');
    assert.equal(after.cancelled_by, memberActor);
    assert.equal(after.cancellation_decision, 'approved');
    assert.equal(after.cancellation_reviewed_by, 'system:frontdesk');
    assert.ok(after.cancellation_requested_at && after.cancellation_reviewed_at);
    const notices = await q("select channel,event_key from S.notice_outbox where booking_id=$1 and event_key like '%:cancelled:%'", [booking]);
    assert.ok(notices.some(n => n.channel === 'admin'), 'administrator cancellation notice queued');
    assert.ok(notices.some(n => n.channel === 'frontdesk'), 'frontdesk cancellation notice queued');
    const audit = await q("select action,actor_role from S.booking_audit_events where target_id=$1 and action='BOOKING_CANCELLED_DIRECT'", [booking]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_role, 'member');

    const repeated = await callCancel(booking);
    assert.equal(repeated.alreadyCancelled, true);
    assert.equal((await q("select count(*)::int n from S.booking_audit_events where target_id=$1 and action='BOOKING_CANCELLED_DIRECT'", [booking]))[0].n, 1);
    assert.equal((await q("select count(*)::int n from S.notice_outbox where booking_id=$1 and event_key like '%:cancelled:%'", [booking]))[0].n, notices.length);
    await assert.rejects(
      invoke('platform_member_direct_cancel_booking', [tenant.id, booking, member, intruder, null]),
      /MEMBERSHIP_REQUIRED/, 'idempotent reply must not bypass principal check');

    const second = await makeBooking();
    await admin('settings.save', { ...config, enabled: false, expectedVersion: 2 });
    await assert.rejects(callCancel(second), /FRONTDESK_DIRECT_CANCELLATION_DISABLED/,
      'disabling the configuration immediately revokes direct cancellation');
    assert.equal((await q('select status from S.bookings where id=$1', [second]))[0].status, 'pending');
    for (const role of ['anon', 'authenticated']) {
      await h.db.exec('set role ' + role);
      await assert.rejects(callCancel(second), /permission denied/);
      await h.db.exec('reset role');
    }
  } finally {
    await h.db.close();
  }
});
