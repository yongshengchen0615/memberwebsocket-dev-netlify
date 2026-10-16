const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261014083341_allow_confirmed_booking_no_show.sql'), 'utf8');

test('pending and confirmed regular bookings share the no-show button and retain distinct follow-up actions', () => {
  assert.match(core, /if \(booking\.status === 'pending' \|\| booking\.status === 'confirmed'\) \{\s*const reason = noShowUnavailableReason\(booking\)/);
  assert.match(core, /if \(booking\.status === 'pending'\) \{\s*actions\.append\(\s*actionButton\('不通過'/);
  assert.match(core, /actionButton\('確認服務完成', 'button button-dark'/);
  assert.match(core, /if \(!\['pending', 'confirmed'\]\.includes\(booking\.status\)\)/);
  assert.match(core, /booking\.receiptSubmissionId \|\| String\(booking\.requestId/);
  assert.match(core, /booking\.cancellationRequestedAt && !booking\.cancellationReviewedAt/);
  assert.match(core, /服務結束後才能標記無故未到/);
  assert.doesNotMatch(core, /我已人工核對，確認這筆仍待確認的預約無故未到/);
});

test('server-side no-show transition remains privileged, time-gated and audited', () => {
  assert.match(migration, /if b\.status not in \('pending','confirmed'\) then raise exception 'BOOKING_NO_SHOW_NOT_ALLOWED'/);
  assert.match(migration, /role='admin' and status='active'/);
  assert.match(migration, /b\.receipt_submission_id is not null/);
  assert.match(migration, /b\.cancellation_requested_at is not null and b\.cancellation_reviewed_at is null/);
  assert.match(migration, /b\.updated_at<>p_expected_updated_at/);
  assert.match(migration, /b\.end_at>=\(clock_timestamp\(\) at time zone 'Asia\/Taipei'\)/);
  assert.match(migration, /insert into public\.booking_audit_events/);
  assert.match(migration, /revoke all on function public\.admin_mark_booking_no_show/);
  assert.match(migration, /grant execute on function public\.admin_mark_booking_no_show\(text,uuid,timestamptz,text\) to service_role/);
});

test('before-end no-show remains disabled without rendering its time warning', () => {
  const marker = '服務結束後才能標記無故未到。';
  const helperStart = core.indexOf('  function noShowDisplayReason(reason) {');
  const helperEnd = core.indexOf('  function openNoShow(', helperStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const context = vm.createContext({ Date });
  vm.runInContext(
    `const NO_SHOW_EARLY_REASON = ${JSON.stringify(marker)};\n` + core.slice(helperStart, helperEnd),
    context,
  );
  assert.equal(context.noShowDisplayReason(marker), '');
  assert.equal(context.noShowDisplayReason('請先處理取消申請。'), '請先處理取消申請。');
  assert.equal(context.noShowDisplayReason(''), '');
  assert.equal(context.noShowUnavailableReason({ status: 'confirmed', endAt: '2099-01-01T10:00:00' }), marker);
  assert.equal(context.noShowUnavailableReason({ status: 'pending', endAt: '2000-01-01T10:00:00' }), '');

  assert.match(core, /noShow\.disabled = Boolean\(reason\); noShow\.title = visibleReason/);
  assert.match(core, /noShow\.setAttribute\('aria-label', visibleReason \?/);
  assert.match(core, /if \(visibleReason\) \{ const hint/);
  assert.match(core, /button\.disabled=Boolean\(reason\)\|\|state\.busy;button\.title=visibleReason/);
  assert.match(core, /hint\.textContent=visibleReason; hint\.hidden=!visibleReason/);

  const loader = fs.readFileSync(path.join(root, 'admin/booking-panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
  assert.match(loader, /no-show-history-20261014-1-hide-early-hint-20261015-1/);
  assert.match(html, /no-show-history-20261014-1-hide-early-hint-20261015-1/);
});
