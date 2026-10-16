const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20260929111500_restore_one_click_clear_scope.sql'),
  'utf8'
);

const referralBaselineMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261001183500_restore_referral_reward_after_one_click_clear.sql'),
  'utf8'
);

test('one-click clear preserves only administrators and rebuilds system defaults', () => {
  assert.match(migration, /create or replace function maintenance\.clear_non_admin_data/i);
  assert.match(migration, /tablename = 'admins'/i);
  assert.match(migration, /maintenance\.ensure_required_system_baseline\(\)/i);
  assert.match(migration, /ADMIN_PRESERVATION_FAILED/);
  assert.doesNotMatch(migration, /membership_terms['")]?\s*,?\s*'membership_consents/i);
  assert.doesNotMatch(migration, /tablename in \([^)]*members/i);
  assert.doesNotMatch(migration, /truncate[^;]*cascade/i);
});

test('one-click clear explicitly covers both public and booking notification data', () => {
  assert.match(migration, /schemaname in \('public', 'booking_notifications'\)/i);
  assert.match(migration, /RESTART IDENTITY/i);
});

test('one-click clear restores the system referral reward template', () => {
  assert.match(referralBaselineMigration, /maintenance\.ensure_referral_reward_baseline\(\)/i);
  assert.match(referralBaselineMigration, /REFERRAL-REWARD/);
  assert.match(referralBaselineMigration, /deleted_at\s*=\s*null/i);
  assert.match(referralBaselineMigration, /perform maintenance\.ensure_referral_reward_baseline\(\)/i);
  assert.match(referralBaselineMigration, /REQUIRED_REFERRAL_REWARD_BASELINE_INVALID/);
});
