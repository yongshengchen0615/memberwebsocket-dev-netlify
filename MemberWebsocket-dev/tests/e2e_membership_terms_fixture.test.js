const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const scopeMigration = read('supabase/migrations/20261005151234_e2e_membership_terms_scope.sql');
const targetMigration = read('supabase/migrations/20261005152023_e2e_membership_terms_target_member.sql');
const memberApi = read('supabase/functions/member-profile-api/index.ts');
const userQaApi = read('supabase/functions/user-test-api/index.ts');
const userControl = read('user-test-control.js');

test('membership terms E2E data is isolated from production legal terms', () => {
  assert.match(scopeMigration, /add column if not exists scope text not null default 'production'/);
  assert.match(scopeMigration, /scope in \('production','e2e'\)/);
  assert.match(targetMigration, /add column if not exists e2e_member_id uuid references public\.members\(id\) on delete cascade/);
  assert.match(targetMigration, /scope='production' and e2e_member_id is null/);
  assert.match(targetMigration, /scope='e2e' and e2e_member_id is not null/);
  assert.match(targetMigration, /membership_terms_production_one_active/);
  assert.match(targetMigration, /membership_terms_e2e_member_one_active/);
});

test('only service-role QA can prepare targeted E2E membership terms', () => {
  assert.match(scopeMigration, /prepare_e2e_membership_terms_fixture/);
  assert.match(targetMigration, /where scope='e2e' and e2e_member_id=p_member_id and status='active'/);
  assert.match(targetMigration, /public\.is_qa_test_provenance\(p_actor\)/);
  assert.match(scopeMigration, /revoke all on function public\.prepare_e2e_membership_terms_fixture[\s\S]*from public,anon,authenticated/);
  assert.match(scopeMigration, /grant execute on function public\.prepare_e2e_membership_terms_fixture[\s\S]*to service_role/);
});

test('full member E2E prepares terms fixture and records an actual consent', () => {
  assert.match(userQaApi, /prepare_e2e_membership_terms_fixture/);
  assert.match(userQaApi, /membership-terms-e2e/);
  assert.match(userQaApi, /termsFixture: termsFixture\.data/);

  assert.match(userControl, /terms\.scope === 'e2e'/);
  assert.match(userControl, /user\.member\.terms\.accept/);
  assert.match(userControl, /validAccepted/);
  assert.match(userControl, /consentRecorded/);
  assert.match(userControl, /const data = await requestCore\('user\.member\.bootstrap'/);
});

test('test accounts read only their targeted E2E terms while real members stay production-scoped', () => {
  assert.match(memberApi, /member\?\.is_test_account === true \? \["e2e", "production"\] : \["production"\]/);
  assert.match(memberApi, /scope === "e2e"\) query = query\.eq\("e2e_member_id", member\.id\)/);
  assert.match(targetMigration, /e2e_member_id=v_member\.id/);
  assert.match(targetMigration, /v_scope text := 'production'/);
});

test('test-data purge removes E2E legal fixtures but preserves production terms', () => {
  assert.match(scopeMigration, /where t\.scope='e2e' and m\.is_test_account is not true[\s\S]*E2E_TERMS_CROSS_BOUNDARY/);
  assert.match(scopeMigration, /delete from public\.membership_consents[\s\S]*t\.scope='e2e'/);
  assert.match(scopeMigration, /delete from public\.membership_terms[\s\S]*where scope='e2e'/);
  assert.doesNotMatch(scopeMigration, /delete from public\.membership_terms\s*;/);
});
