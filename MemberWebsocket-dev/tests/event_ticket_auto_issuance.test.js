const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const historical = read('supabase/migrations/20261123120000_event_ticket_automatic_issuance.sql');
const usage = read('supabase/migrations/20261123133000_event_ticket_redemption_quota_not_issuance.sql');
const api = read('supabase/functions/api/index.ts');
const event = read('event/app.js');
const admin = read('admin/app.js');

test('AC-001: only issued claims are visible; legacy member claim cannot create a new one', () => {
  assert.match(api, /if \(!claimRow && !transferredOut\) return \[\];/);
  assert.match(api, /canClaim: false,/);
  assert.doesNotMatch(event, /user\.event\.ticket\.claim/);
  assert.doesNotMatch(event, /claimTicket\(/);
  assert.match(event, /由系統發放至符合條件的 LINE 會員帳戶/);
  assert.match(historical, /raise exception 'EVENT_TICKET_ISSUANCE_ONLY'/);
});

test('AC-002: activation issues to all eligible members regardless of quota', () => {
  assert.match(usage, /create or replace function public\.issue_eligible_general_event_ticket/);
  assert.match(usage, /and coalesce\(public\.current_tier_key\(m\.id\)=any\(v_event\.allowed_tier_keys\),false\)/);
  assert.match(usage, /on conflict \(event_ticket_id,member_id\) do nothing/);
  assert.match(usage, /status='active' and deleted_at is null/);
  assert.doesNotMatch(usage.match(/create or replace function public\.issue_eligible_general_event_ticket[\s\S]*?\$body\$;/)[0], /limit v_slots|new\.quota\s*>/i);
});

test('AC-003: finite quota applies at every used-status transition under a database row lock', () => {
  assert.match(usage, /before update of status on public\.event_ticket_claims/);
  assert.match(usage, /where id=v_source_id for update/);
  assert.match(usage, /where c\.status='used'/);
  assert.match(usage, /raise exception 'EVENT_USAGE_QUOTA_REACHED'/);
  assert.match(usage, /raise exception 'EVENT_USAGE_QUOTA_BELOW_USED_COUNT'/);
  assert.match(api, /"EVENT_USAGE_QUOTA_REACHED",409/);
  assert.match(api, /usedCounts\.get\(row\.id\)/);
});

test('AC-004: future and existing merchant schemas inherit the same guarded quota semantics', () => {
  assert.match(usage, /platform_private\.business_templates/);
  assert.match(usage, /guard_event_ticket_redemption_quota/);
  assert.match(usage, /guard_event_ticket_quota_reduction/);
  assert.match(usage, /event_ticket_used_counts/);
  assert.match(usage, /bind_member_referral/);
  assert.match(usage, /business_\[0-9a-f\]\{32\}/);
});

test('AC-005: activation confirmation explains unlimited issuance and usage-only quota', () => {
  assert.match(admin, /const issuingNow = ticket\.status === 'active'/);
  assert.match(admin, /window\.confirm\(/);
  assert.match(admin, /發放張數不設上限/);
  assert.match(admin, /只有成功使用／核銷才計入上限/);
  assert.match(read('admin/index.html'), /只有成功使用／核銷才占用 1 次使用名額/);
});
