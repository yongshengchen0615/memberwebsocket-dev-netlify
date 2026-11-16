import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = filename => readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
const flow = read('.github/workflows/publish-netlify.yml');
const ci = read('.github/workflows/test-memberwebsocket-dev.yml');
const planner = read('scripts/fullstack-release-plan.mjs');

test('AC-011 production is blocked until an explicit audited full-stack baseline exists', () => {
  assert.match(flow, /refs\/tags\/production-fullstack:refs\/tags\/production-fullstack/);
  assert.match(flow, /Missing audited production-fullstack baseline/);
  assert.match(flow, /git merge-base --is-ancestor/);
  assert.ok(flow.indexOf('refs/tags/production-fullstack') < flow.indexOf('netlify-cli@'));
});

test('AC-012 production SQL preflight precedes Edge Functions and frontend', () => {
  const ciGate = flow.indexOf('node scripts/check-preview-ci.mjs');
  const sqlDryRun = flow.indexOf('supabase db push --linked --dry-run');
  const sqlApply = flow.indexOf('supabase db push --linked --yes');
  const edgeDeploy = flow.indexOf('supabase functions deploy "$function_name"');
  const frontend = flow.indexOf('netlify-cli@23.11.0 deploy --prod');
  assert.ok(ciGate >= 0 && sqlDryRun > ciGate && sqlApply > sqlDryRun
    && edgeDeploy > sqlApply && frontend > edgeDeploy);
  assert.doesNotMatch(flow, /supabase db (reset|push .*--include-all)|supabase migration repair/);
  assert.match(flow, /PROJECT_REF: dbuquirnaskrwcamdxki/);
});

test('AC-013 only production-scoped deployment credentials are referenced', () => {
  assert.match(flow, /SUPABASE_PRODUCTION_ACCESS_TOKEN/);
  assert.match(flow, /SUPABASE_PRODUCTION_DB_PASSWORD/);
  assert.doesNotMatch(flow, /SUPABASE_TEST_ACCESS_TOKEN|bmwhojszsnxliekkhrka/);
  assert.match(flow, /version: v2.stable/);
  assert.match(flow, /steps.backend_plan.outputs.functions != '0'/);
  assert.match(flow, /steps.backend_plan.outputs.migrations != '0'/);
});

test('AC-014 the full-stack tag advances only after actual production web verification', () => {
  const verified = flow.indexOf('Published production site matches master $GITHUB_SHA');
  const advance = flow.indexOf('git push --force-with-lease=');
  assert.ok(verified >= 0 && advance > verified);
  assert.match(flow, /test "\$current" = "\$GITHUB_SHA"/);
  assert.match(flow, /permissions:\n  contents: write/);
});

test('AC-015 planner excludes retired APIs and blocks mutation of applied migration sources', () => {
  assert.match(planner, /retiredFunctions/);
  assert.match(planner, /status !== 'A'/);
  assert.match(planner, /function import escapes source tree/);
  assert.match(planner, /shared dependency cannot be proven to be deployed/);
});

test('AC-016 every master push and PR runs release-planner contract tests', () => {
  assert.match(ci, /scripts\/fullstack-release-plan.test.mjs/);
  assert.match(ci, /scripts\/fullstack-release-workflow.test.mjs/);
  assert.match(ci, /^  pull_request:/m);
  assert.match(ci, /^  push:/m);
});
