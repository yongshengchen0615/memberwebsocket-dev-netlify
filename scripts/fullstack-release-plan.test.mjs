import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makePromotionPlan, parseNameStatus } from './fullstack-release-plan.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'fullstack-release-'));
  const functions = path.join(root, 'MemberWebsocket-dev/supabase/functions');
  mkdirSync(path.join(functions, 'api'), { recursive: true });
  mkdirSync(path.join(functions, 'platform-api'), { recursive: true });
  mkdirSync(path.join(functions, 'test-mode-api'), { recursive: true });
  mkdirSync(path.join(functions, '_shared'), { recursive: true });
  mkdirSync(path.join(root, 'MemberWebsocket-dev/supabase/retirement'), { recursive: true });
  writeFileSync(path.join(root, 'MemberWebsocket-dev/supabase/retirement/retired-endpoints.json'),
    JSON.stringify({ retiredFunctions: ['test-mode-api'] }));
  writeFileSync(path.join(functions, 'api/index.ts'),
    "import { x } from '../_shared/runtime.ts'; export default x;");
  writeFileSync(path.join(functions, 'platform-api/index.ts'), 'export default 1;');
  writeFileSync(path.join(functions, 'test-mode-api/index.ts'), 'export default 2;');
  writeFileSync(path.join(functions, '_shared/runtime.ts'), "export { x } from './helpers.ts';");
  writeFileSync(path.join(functions, '_shared/helpers.ts'), 'export const x = 1;');
  const migrations = path.join(root, 'MemberWebsocket-dev/supabase/migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(path.join(migrations, '20261116103000_safe_addition.sql'), 'SELECT 1;');
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const changed = (status, filename) => ({ status, path: filename });
const migration = 'MemberWebsocket-dev/supabase/migrations/20261116103000_safe_addition.sql';
const edge = 'MemberWebsocket-dev/supabase/functions/';

test('AC-001 release accepts only newly added, ordered SQL migrations', () => fixture(root => {
  const plan = makePromotionPlan([changed('A', migration)], { root, base, head });
  assert.deepEqual(plan.migrations, [migration]);
  assert.deepEqual(plan.functions, []);
  assert.equal(plan.environment, 'production');
}));

test('AC-001b testing Supabase project, preview URL, or reset SQL cannot enter production', () => fixture(root => {
  const file = path.join(root, migration);
  for (const literal of [
    'https://bmwhojszsnxliekkhrka.supabase.co',
    'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app',
    'MemberWebsocket-test',
    'RESET MEMBERWEBSOCKET TEST DATA',
  ]) {
    writeFileSync(file, "SELECT '" + literal + "';");
    assert.throws(() => makePromotionPlan([changed('A', migration)], { root }),
      /testing environment URL, project, or reset marker/);
  }
}));

test('AC-002 previous migrations cannot be edited, renamed, or deleted', () => fixture(root => {
  for (const status of ['M', 'D', 'R']) {
    assert.throws(() => makePromotionPlan([changed(status, migration)], { root }),
      /historical migration/);
  }
  assert.throws(() => makePromotionPlan([changed('A', migration.replace('20261116103000', 'bad'))], { root }),
    /historical migration/);
}));

test('AC-003 changed canonical Edge entrypoints are selected, not blanket deployed', () => fixture(root => {
  const plan = makePromotionPlan([changed('M', edge + 'platform-api/index.ts')], { root });
  assert.deepEqual(plan.functions, ['platform-api']);
  assert.deepEqual(plan.migrations, []);
}));

test('AC-004 transitive _shared changes deploy only their actual importers', () => fixture(root => {
  const plan = makePromotionPlan([changed('M', edge + '_shared/helpers.ts')], { root });
  assert.deepEqual(plan.functions, ['api']);
}));

test('AC-005 an unreferenced shared dependency blocks production rather than silently skipping', () => fixture(root => {
  writeFileSync(path.join(root, edge, '_shared/unused.ts'), 'export const unused = true;');
  assert.throws(() => makePromotionPlan([changed('M', edge + '_shared/unused.ts')], { root }),
    /cannot be proven/);
}));

test('AC-006 retired QA APIs are never deployed as live implementations', () => fixture(root => {
  assert.throws(() => makePromotionPlan([changed('M', edge + 'test-mode-api/index.ts')], { root }),
    /retired function/);
}));

test('AC-007 Supabase auth config and retirement manifest require separate review', () => fixture(root => {
  for (const item of ['MemberWebsocket-dev/supabase/config.toml',
    'MemberWebsocket-dev/supabase/retirement/retired-endpoints.json',
    'MemberWebsocket-dev/supabase/seed.sql',
    'MemberWebsocket-dev/supabase/import_map.json']) {
    assert.throws(() => makePromotionPlan([changed('M', item)], { root }), /separate review/);
  }
}));

test('AC-008 frontend-only releases include no backend actions', () => fixture(root => {
  const plan = makePromotionPlan([changed('M', 'MemberWebsocket-dev/index.html')], { root });
  assert.deepEqual(plan.migrations, []);
  assert.deepEqual(plan.functions, []);
}));

test('AC-009 invalid and unknown function paths cannot silently drop backend changes', () => fixture(root => {
  assert.throws(() => makePromotionPlan([changed('A', edge + 'new-function/index.ts')], { root }),
    /no deployable entrypoint/);
  assert.throws(() => makePromotionPlan([changed('M', edge + '_shared/missing.ts')], { root }),
    /cannot be proven/);
}));

test('AC-010 git NUL name/status parsing preserves rename and addition status', () => {
  const input = Buffer.from('A\0file.sql\0R100\0old.sql\0new.sql\0', 'utf8');
  assert.deepEqual(parseNameStatus(input), [
    { status: 'A', path: 'file.sql', originalPath: undefined },
    { status: 'R', path: 'new.sql', originalPath: 'old.sql' },
  ]);
  assert.throws(() => parseNameStatus(Buffer.from('INVALID\0file\0')), /invalid git diff/);
});
