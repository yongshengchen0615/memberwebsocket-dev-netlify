const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = fs.readFileSync(path.join(__dirname, '../supabase/functions/test-control-api/index.ts'), 'utf8');

test('recycle errors separate cross-member links from residual QA assets', () => {
  const section = api.slice(
    api.indexOf('if (action === "admin.test-control.recycle-e2e-runtime")'),
    api.indexOf('if (action === "admin.test-control.e2e-profile")')
  );
  assert.ok(section.includes('reason.includes("TEST_DATA_CROSS_BOUNDARY")'));
  assert.ok(section.includes('blockage: "cross_member_boundary"'));
  assert.ok(section.includes('reason.includes("E2E_RECYCLE_QA_ARTIFACTS_REMAIN")'));
  assert.ok(section.includes('blockage: "qa_artifacts_remain"'));
  assert.ok(section.indexOf('blockage: "cross_member_boundary"') <
    section.indexOf('blockage: "qa_artifacts_remain"'));
  assert.match(section, /E2E_RECYCLE_BUSY/);
  assert.match(section, /E2E_RECYCLE_BLOCKED/);
  assert.match(section, /E2E_RECYCLE_FAILED/);
});

test('recycle residual count parses a bounded aggregate without returning raw SQL errors', () => {
  const parserLine = api.split('\n').find(line =>
    line.includes('const remaining = /E2E_RECYCLE_QA_ARTIFACTS_REMAIN:'));
  assert.ok(parserLine, 'expected the actual production regex expression');
  const parser = vm.runInNewContext(parserLine.split(' = ')[1].split('.exec(reason)')[0]);
  assert.equal(parser.exec('E2E_RECYCLE_QA_ARTIFACTS_REMAIN: 17')[1], '17');
  assert.equal(parser.exec('prefix E2E_RECYCLE_QA_ARTIFACTS_REMAIN: 0')[1], '0');
  assert.equal(parser.exec('E2E_RECYCLE_QA_ARTIFACTS_REMAIN: unknown'), null);
  assert.ok(!parserLine.includes('new ApiError'), 'only the safe count should be parsed');
});

test('admin UI displays only bounded QA aggregate counts and never exposes raw SQL error text', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../admin/e2e-control.js'), 'utf8');
  const start = runner.indexOf("const blocker = parsed?.error?.details;");
  const snippet = runner.slice(start, start + 500);
  assert.ok(start >= 0);
  assert.match(snippet, /blocker\?\.blockage === 'qa_artifacts_remain'/);
  assert.match(snippet, /Number\.isSafeInteger\(count\)/);
  assert.match(snippet, /count > 0 && count <= 1000000/);
  assert.ok(!snippet.includes('JSON.stringify(blocker)'));
});
