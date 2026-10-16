const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('member directory splits real and test users with one shared renderer', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  assert.match(html, /id="realMembersSubtab"/);
  assert.match(html, /id="testMembersSubtab"/);
  assert.match(app, /memberKind: 'real'/);
  assert.match(app, /switchMemberKind\('real'\)/);
  assert.match(app, /switchMemberKind\('test'\)/);
  assert.match(app, /memberKind: state\.memberKind/);
  assert.equal((app.match(/function renderMembers\(/g) || []).length, 1);
});

test('admin API pages real and test members through the same domain model', () => {
  const api = read('supabase/functions/api/index.ts');
  assert.match(api, /memberKind = "real"/);
  assert.match(api, /const isTestAccount = asText\(memberKind,10\).*=== "test"/);
  assert.match(api, /\.eq\("is_test_account",isTestAccount\)/);
  for (const field of ['birthday', 'phone', 'surname', 'salutation', 'isTestAccount', 'testAccountSequence']) {
    assert.ok(api.includes(field), field);
  }
});

test('only test member virtual profile is editable from admin', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const api = read('supabase/functions/api/index.ts');
  assert.match(html, /id="memberTestProfileFields"/);
  assert.match(html, /id="memberDisplayName"/);
  assert.match(html, /id="memberSurname"/);
  assert.match(html, /id="memberSalutation"/);
  assert.match(html, /id="memberBirthday"/);
  assert.match(html, /id="memberPhone"/);
  assert.match(app, /els\.memberIsTestAccount\.value === 'true'/);
  assert.match(api, /current\.data\.is_test_account === true && profile/);
  assert.match(api, /TEST_PROFILE_ONLY/);
  assert.match(api, /action:"ADMIN_MEMBER_UPDATE"/);
});

test('test grants never enter LINE push notification path', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const api = read('supabase/functions/api/index.ts');
  assert.match(html, /id="grantTestNotificationNote"/);
  assert.match(html, /測試用戶僅建立測試資料，不會傳送 LINE 訊息/);
  assert.match(app, /grantMessageSection\.classList\.toggle\('hidden', isTestAccount\)/);
  assert.match(api, /isTestAccount[\s\S]*測試用戶不發送 LINE 通知/);
  assert.match(api, /Boolean\(grantResult\.applied\) && !isTestAccount/);
  assert.match(api, /messagePresetId && !isTestAccount/);
});

test('new and existing test accounts have complete virtual profiles', () => {
  const migration = read('supabase/migrations/20260920150345_test_member_full_profile.sql');
  assert.match(migration, /where is_test_account = true/);
  assert.match(migration, /surname = coalesce/);
  assert.match(migration, /salutation = case/);
  assert.match(migration, /date '1990-01-01'/);
  assert.match(migration, /case when v_seq % 2 = 0 then 'ms' else 'mr' end/);
  assert.match(migration, /membership_status = 'active'/);
});


test('test account generator creates varied human-like virtual profiles', () => {
  const migration = read('supabase/migrations/20260920152808_randomize_test_member_profiles.sql');
  assert.match(migration, /v_surnames text\[\]/);
  assert.match(migration, /v_male_names text\[\]/);
  assert.match(migration, /v_female_names text\[\]/);
  assert.match(migration, /random\(\) < 0\.5/);
  assert.match(migration, /current_date - make_interval\(years => 18 \+ floor\(random\(\) \* 48\)::int\)/);
  assert.match(migration, /'09' \|\| lpad\(floor\(random\(\) \* 100000000\)::bigint::text, 8, '0'\)/);
  assert.match(migration, /v_surname \|\| v_given_name \|\| '（測試）'/);
  assert.match(migration, /exit when not exists \(select 1 from public\.members where phone = v_phone\)/);
});
