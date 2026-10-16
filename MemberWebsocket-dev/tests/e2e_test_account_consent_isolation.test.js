const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'supabase/functions/test-control-api/index.ts'), 'utf8');
const begin = apiSource.indexOf('async function prepareTestAccountConsents(');
const end = apiSource.indexOf('\nasync function prepareComplexFixtures(', begin);
assert.ok(begin >= 0 && end > begin, 'test-control consent helper must exist');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const N = '44444444-4444-4444-8444-444444444444';
const past = '2026-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';
const term = (id, scope, target, reconsent = true, effectiveAt = past) => ({
  id, scope, e2e_member_id: target || null, status: 'active',
  version: id, required: true, reconsent_existing: reconsent,
  effective_at: effectiveAt, activated_at: effectiveAt,
});
const members = [A, B, C].map(id => ({ id, is_test_account: true, status: 'active', membership_status: 'active' }));

function fakeDb(terms = [], selectedMembers = members, consents = []) {
  const tables = {
    members: selectedMembers.map(x => ({ ...x })),
    membership_terms: terms.map(x => ({ ...x })),
    membership_consents: consents.map(x => ({ ...x })),
  };
  let upsertCount = 0;
  const client = {
    from(name) {
      assert.ok(Object.hasOwn(tables, name), name);
      const clauses = [];
      const builder = {
        select() { return this; },
        eq(k, v) { clauses.push(row => row[k] === v); return this; },
        in(k, vs) { clauses.push(row => vs.includes(row[k])); return this; },
        maybeSingle() {
          const rows = tables[name].filter(row => clauses.every(fn => fn(row)));
          return Promise.resolve(rows.length <= 1
            ? { data: rows[0] || null, error: null }
            : { data: null, error: { message: 'duplicate active terms' } });
        },
        upsert(rows) {
          assert.equal(name, 'membership_consents');
          for (const row of rows) {
            const hasPair = tables[name].some(x => x.member_id === row.member_id && x.terms_id === row.terms_id);
            if (!hasPair) { tables[name].push({ ...row }); upsertCount++; }
          }
          return Promise.resolve({ error: null });
        },
        then(resolve, reject) {
          const rows = tables[name].filter(row => clauses.every(fn => fn(row)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, tables, get upsertCount() { return upsertCount; } };
}

function loadHelper() {
  const source = stripTypeScriptTypes(apiSource.slice(begin, end));
  const ctx = {
    asText: (v, max) => String(v == null ? '' : v).slice(0, max),
    ApiError: class ApiError extends Error {
      constructor(status, code, message) { super(message); this.status = status; this.code = code; }
    },
    audit: async () => {},
    emitRealtimeEvent: async () => {},
    Date, Number, Set, Map,
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nthis.prepare = prepareTestAccountConsents;', ctx, { timeout: 1000 });
  return ctx.prepare;
}
const prepare = loadHelper();
const call = (db, ids) => prepare(db.client, { lineUserId: 'QA' }, { memberIds: ids });

test('selected QA members receive only their own effective E2E terms or production fallback', async () => {
  const db = fakeDb([term('prod', 'production'), term('target-A', 'e2e', A), term('foreign-C', 'e2e', C)]);
  const result = await call(db, [A, B]);
  assert.equal(result.currentConsentCount, 2);
  assert.equal(result.consentRequiredCount, 2);
  assert.equal(result.insertedCount, 2);
  assert.deepEqual(db.tables.membership_consents
    .map(x => [x.member_id, x.terms_id]).sort(), [[A, 'target-A'], [B, 'prod']].sort());
  assert.equal(db.tables.membership_consents.some(x => x.terms_id === 'foreign-C'), false);
  const again = await call(db, [A, B]);
  assert.equal(again.insertedCount, 0, 'repeated preflight must be idempotent');
  assert.equal(db.upsertCount, 2);
});

test('newly activated targeted E2E terms supersede prior consents on next surface', async () => {
  const db = fakeDb([term('prod', 'production')]);
  await call(db, [A]);
  db.tables.membership_terms.push(term('new-A', 'e2e', A));
  const result = await call(db, [A]);
  assert.equal(result.insertedCount, 1);
  assert.ok(db.tables.membership_consents.some(x => x.member_id === A && x.terms_id === 'new-A'));
});

test('not yet effective and optional terms are not prematurely accepted', async () => {
  const db = fakeDb([term('prod', 'production'), term('future-A', 'e2e', A, true, future),
    term('optional-B', 'e2e', B, false)]);
  const result = await call(db, [A, B]);
  assert.equal(result.consentRequiredCount, 1);
  assert.deepEqual(db.tables.membership_consents.map(x => [x.member_id, x.terms_id]), [[A, 'prod']]);
});

test('never synthesizes QA consent for formal or inactive members', async () => {
  const db = fakeDb([term('prod', 'production')], [
    ...members, { id: N, is_test_account: false, status: 'active', membership_status: 'active' },
  ]);
  await assert.rejects(call(db, [A, N]), e => e.code === 'TEST_MEMBER_SELECTION_FORBIDDEN');
  assert.equal(db.upsertCount, 0);
});

test('existing non-accepted consent does not count as accepted', async () => {
  const db = fakeDb([term('prod', 'production')], members, [
    { member_id: A, terms_id: 'prod', result: 'rejected' },
  ]);
  await assert.rejects(call(db, [A]), e => e.code === 'MEMBERSHIP_CONSENT_FIXTURE_INCOMPLETE');
});

test('absence of effective reconsent terms is an explicitly skipped preflight', async () => {
  const db = fakeDb([term('future', 'e2e', A, true, future)]);
  const result = await call(db, [A]);
  assert.equal(result.skipped, true);
  assert.equal(result.consentRequiredCount, 0);
  assert.equal(db.upsertCount, 0);
});

test('paired runner refreshes consents before non-member surfaces without skipping server auth', () => {
  const runner = fs.readFileSync(path.join(root, 'admin/e2e-control.js'), 'utf8');
  const session = runner.slice(runner.indexOf('async function createPairedSession('), runner.indexOf('async function createPairedSession(') + 1900);
  assert.match(session, /if \(surface !== 'member'\)[\s\S]*await prepareEphemeralConsents\(\[account\]\)/);
  assert.match(session, /test-mode\.login/);
  assert.ok(session.indexOf('prepareEphemeralConsents') < session.indexOf("action: 'test-mode.login'"));
});
