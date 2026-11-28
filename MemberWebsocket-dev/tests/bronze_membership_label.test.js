'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AC-001: general remains the lowest entitlement tier while presented as 銅級會員', async () => {
  const { buildMonthlyTierOverview } = await import('../supabase/functions/_shared/monthly-tier-benefits.mjs');
  const view = buildMonthlyTierOverview({ month: '2026-11' });
  assert.deepEqual(view.tiers.map((tier) => tier.key), ['general', 'silver', 'gold', 'platinum']);
  assert.deepEqual(view.tiers.map((tier) => tier.label), ['銅級會員', '銀級會員', '金級會員', '白金會員']);
  const { tierVisibility } = await import('../supabase/functions/_shared/tier-visibility.ts');
  const eligible = tierVisibility(['general'], 'general', 'eligible_only');
  assert.equal(eligible.tierEligible, true);
  assert.deepEqual(eligible.requiredTierLabels, ['銅級會員']);
  assert.equal(tierVisibility(['silver'], 'general', 'eligible_only').tierEligible, false);
});

test('AC-002: milestone and calendar recognize the new name and the legacy aliases', () => {
  const milestones = read('membership-milestones.js');
  assert.match(milestones, /key: 'general', label: '銅級', aliases: \['銅級會員', '銅級', '一般會員', '一般'\]/);
  const calendar = read('calendar/app.js');
  assert.match(calendar, /'銅級會員': 0/);
  assert.match(calendar, /'一般會員': 0/);
  assert.match(calendar, /'general', 'silver', 'gold', 'platinum'/);
});

test('AC-003: member, booking, admin and server entry points use the bronze label', () => {
  const sources = [
    'member/app.js', 'booking/app.js', 'admin/app.js', 'admin/index.html',
    'member/index.html', 'member/membership-progress.js',
    'points/membership-progress.js', 'booking/membership-progress.js',
    'calendar/membership-progress.js', 'event/membership-progress.js',
    'supabase/functions/api/index.ts',
    'supabase/functions/member-profile-api/index.ts',
    'supabase/functions/member-calendar-api/index.ts',
    'event-ticket-ui.js', 'admin/grant-automation.js',
    'supabase/functions/booking-line-notifications/benefits.ts',
    'supabase/functions/grant-automation/index.ts',
    'supabase/functions/scheduled-grant-messages/index.ts',
  ];
  for (const file of sources) assert.match(read(file), /銅級會員/, file);
});

test('AC-004: migration only renames the default general label, without changing rank or eligibility', () => {
  const migration = read('supabase/migrations/20261128155000_general_tier_bronze_label.sql');
  assert.match(migration, /UPDATE public\.membership_tier_settings/i);
  assert.match(migration, /tier_label\s*=\s*'銅級會員'/i);
  assert.match(migration, /tier_key\s*=\s*'general'/i);
  assert.match(migration, /tier_label\s*=\s*'一般會員'/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM|required_service_minutes\s*=/i);
});
