const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('referral rewards go only to the inviter and remain repeatable per distinct invitee', () => {
  const migration = read('supabase/migrations/20261003123000_referral_inviter_only_repeatable_rewards.sql');
  const api = read('supabase/functions/api/index.ts');
  const admin = read('admin/app.js');
  const adminHtml = read('admin/index.html');
  const member = read('member/member-growth.js');

  assert.match(migration, /invitee_member_id = v_invitee\.id/);
  assert.match(migration, /referral_source_event_ticket_id is null/);
  assert.match(migration, /'rewardRecipient', 'inviter'/);
  assert.match(migration, /'rewardCount', 1/);
  assert.match(migration, /v_reward_event\.id,\s*v_inviter\.id,\s*'referral'/s);
  assert.doesNotMatch(migration, /v_reward_event\.id,\s*v_invitee\.id,\s*'referral'/s);
  assert.match(migration, /if v_claim_count >= v_source_event\.quota then/);
  assert.doesNotMatch(migration, /v_claim_count \+ 2/);
  assert.match(migration, /event_tickets_one_active_referral_idx[\s\S]*referral_source_event_ticket_id is null/);

  assert.doesNotMatch(api, /INVALID_REFERRAL_QUOTA/);
  assert.match(api, /referral_source_event_ticket_id/);
  assert.doesNotMatch(admin, /好友邀請每次會發放兩張票券/);
  assert.match(adminHtml, /好友邀請票券則每成功邀請 1 位新會員，由邀請者獲得 1 張/);
  assert.match(member, /每成功邀請一位不同會員可獲得 1 張優惠票券/);
});

test('invitee uniqueness remains the referral binding boundary', () => {
  const originalMigration = read('supabase/migrations/20260930150500_member_referral_rewards.sql');
  assert.match(originalMigration, /invitee_member_id uuid not null unique references public\.members\(id\)/);
  assert.doesNotMatch(originalMigration, /inviter_member_id uuid not null unique/);
});
