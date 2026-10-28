const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('member profile editors use the shared session broker instead of delayed polling', () => {
  const system = read('member-system.js');
  const profile = read('member/profile-extension.js');
  const birthday = read('member/profile-birthday-edit.js');

  assert.match(system, /const sessions = new Map\(\)/);
  assert.match(system, /sessions\.set\(surface/);
  assert.match(system, /function getSession\(surface\)/);
  assert.match(profile, /getSession\('member'\)/);
  assert.match(profile, /system\.request\(config, 'member', idToken, action, payload\)/);
  assert.match(birthday, /system\.getSession\('member'\)/);
  assert.match(birthday, /system\.request\(session\.config, 'member', session\.idToken, action, payload\)/);
  assert.doesNotMatch(profile, /scheduleProfileSync|fetchCurrentProfile\(16\)|wait\(350\)/);
  assert.doesNotMatch(profile, /fetch\(/);
  assert.doesNotMatch(birthday, /fetch\(/);
});

test('member card renders honorific from the primary profile source', () => {
  const app = read('member/app.js');
  const profile = read('member/profile-extension.js');
  assert.match(app, /memberHonorificName/);
  assert.match(app, /salutation === 'mr' \? '先生' : salutation === 'ms' \? '小姐'/);
  assert.match(app, /member-profile-ready/);
  assert.match(profile, /window\.addEventListener\('member-profile-ready'/);
});


test('member bootstrap and profile save use the dedicated profile API', () => {
  const system = read('member-system.js');
  const html = read('member/index.html');

  assert.match(system, /clientType === 'member' && \(action === 'user\.member\.bootstrap' \|\| action === 'user\.member\.profile\.save' \|\| action === 'user\.member\.terms\.accept' \|\| action === 'user\.member\.card\.open' \|\| action === 'user\.member\.invitation\.claim' \|\| action === 'user\.member\.oa\.check'\)/);
  assert.match(system, /\/functions\/v1\/member-profile-api/);
  assert.match(html, /member-system\.js\?v=[^"'\\s>]+/);
});

test('profile edit actions use independent partial updates through the shared transport', () => {
  const profile = read('member/profile-extension.js');
  const birthday = read('member/profile-birthday-edit.js');
  const api = read('supabase/functions/member-profile-api/index.ts');

  assert.match(profile, /saveProfilePayload\(\{ surname, salutation \}\)/);
  assert.match(profile, /MemberPhone\?\.compose\(valueOf\('phoneEditCountryCode'\), valueOf\('phoneEditInput'\)\)/);
  assert.match(profile, /saveProfilePayload\(\{ phone \}\)/);
  assert.match(birthday, /requestProfile\('user\.member\.profile\.save', \{ birthday \}\)/);
  assert.match(profile, /member-profile-updated/);
  assert.match(birthday, /member-profile-updated/);
  assert.match(api, /const hasBirthday = Object\.prototype\.hasOwnProperty\.call\(body, "birthday"\)/);
  assert.match(api, /const hasPhone = Object\.prototype\.hasOwnProperty\.call\(body, "phone"\)/);
  assert.match(api, /const hasSurname = Object\.prototype\.hasOwnProperty\.call\(body, "surname"\)/);
  assert.match(api, /const hasSalutation = Object\.prototype\.hasOwnProperty\.call\(body, "salutation"\)/);
});

test('profile editors do not inspect LIFF credentials directly', () => {
  const profile = read('member/profile-extension.js');
  const birthday = read('member/profile-birthday-edit.js');

  for (const source of [profile, birthday]) {
    assert.doesNotMatch(source, /getIDToken|window\.liff|liff\.getIDToken/);
    assert.match(source, /MemberSystem/);
  }
});

test('member modal automation waits for real UI transitions and keeps safe diagnostics visible', () => {
  const qa = read('user-test-control.js');
  const birthday = read('member/profile-birthday-edit.js');

  assert.match(qa, /async function waitForModalState\(modal, shouldBeOpen, timeoutMs\)/);
  assert.match(qa, /const opened = await waitForModalState\(modal, true, 1500\)/);
  assert.doesNotMatch(qa, /open\.click\(\);\s*await wait\(60\)/);
  assert.match(qa, /const sensitiveScalar = blocked\.test\(key\)/);

  const openFunction = birthday.slice(
    birthday.indexOf('async function openBirthdayModal'),
    birthday.indexOf('function closeBirthdayModal')
  );
  assert.ok(openFunction.indexOf("modal.classList.remove('hidden')") < openFunction.indexOf('const profile = await ensureCurrentProfile()'));
  assert.match(openFunction, /if \(!modal\.classList\.contains\('hidden'\)\) document\.getElementById\('birthdayEditYear'\)\?\.focus\(\)/);
});
