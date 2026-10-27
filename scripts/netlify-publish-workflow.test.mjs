import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const path = new URL('../.github/workflows/publish-netlify.yml', import.meta.url);
const flow = readFileSync(path, 'utf8');
const fullCI = readFileSync(new URL('../.github/workflows/test-memberwebsocket-dev.yml', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../.github/workflows/publish-platform-preview.yml', import.meta.url), 'utf8');
const build = readFileSync(new URL('../.github/workflows/test-netlify-build.yml', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../.github/workflows/test-memberwebsocket-ticket-policy.yml', import.meta.url), 'utf8');

test('PR merge runs cannot cancel a branch push release baseline', () => {
  const concurrency = fullCI.split('concurrency:')[1].split('jobs:')[0];
  assert.match(concurrency, /github\.event_name/);
  assert.match(concurrency, /github\.event\.pull_request\.number/);
  assert.match(concurrency, /github\.ref/);
});

test('preview retrieves exact SHA push evidence for its source branch', () => {
  assert.match(preview, /-f event=push/);
  assert.match(preview, /-f head_sha="\$GITHUB_SHA"/);
  assert.match(preview, /-f branch="\$GITHUB_REF_NAME"/);
});

test('production deploy targets only the recreated Netlify site with protected credentials', () => {
  assert.match(flow, /NETLIFY_SITE_ID: 196e1d2c-8216-4ba8-aeb9-1706660adc2b/);
  assert.match(flow, /NETLIFY_AUTH_TOKEN: \$\{\{ secrets\.NETLIFY_AUTH_TOKEN \}\}/);
  assert.match(flow, /if \[ -z .*NETLIFY_AUTH_TOKEN/);
  assert.match(flow, /--prod --no-build --dir=dist --site=/);
  assert.doesNotMatch(flow, /--allow-anonymous|--alias=develop/);
});

test('deployment is gated by the entire test baseline of its exact develop commit', () => {
  assert.match(flow, /branches: \[develop\]/);
  assert.match(flow, /test-memberwebsocket-dev\.yml\/runs/);
  assert.match(flow, /select\(\.head_sha == \$sha\)/);
  assert.match(flow, /success\) echo/);
  assert.match(flow, /failure\|cancelled\|timed_out/);
});

test('deploy emits recoverable artifact and verifies both page and JS after publishing', () => {
  assert.match(flow, /actions\/upload-artifact@v4/);
  assert.match(flow, /name: netlify-dist-/);
  assert.match(flow, /scripts\/build-site\.mjs/);
  assert.match(flow, /booking-multi-details-20261017-1/);
  assert.match(flow, /dist\/points\/pointcard-ticket-overview\.js/);
  assert.match(flow, /data-commit=/);
  // Production CDN propagation must never turn a correct deploy into a false
  // negative. The smoke check keeps strict assertions on every retry.
  assert.match(flow, /for attempt in \$\(seq 1 30\)/);
  assert.match(flow, /html_ok=0/);
  assert.match(flow, /js_ok=0/);
  assert.match(flow, /version_ok=0/);
  assert.match(flow, /\[\[ "\$html_ok" == 1 && "\$js_ok" == 1 && "\$version_ok" == 1 \]\]/);
  assert.match(flow, /after 30 checks/);
});

test('deployment changes trigger the full suite on push and every pull request', () => {
  const sections = fullCI.split('  pull_request:');
  assert.equal(sections.length, 2);
  const push = sections[0];
  const pr = sections[1].split('permissions:')[0];
  assert.match(push, /'\.github\/workflows\/publish-netlify\.yml'/);
  assert.match(push, /'scripts\/\*\*'/);
  assert.doesNotMatch(pr, /^\s+(?:paths|paths-ignore|branches|branches-ignore):/m);
});

test('preview uses the latest exact-commit CI gate before publishing and preserves alias scope', () => {
  assert.ok(preview.indexOf('node scripts/check-preview-ci.mjs') < preview.indexOf('node scripts/verify-netlify-native-preview.mjs'));
  assert.ok(preview.indexOf('node scripts/check-preview-ci.mjs') < preview.indexOf('netlify-cli@'));
  assert.match(preview, /if \[ "\$result" != 2 \]/);
  assert.match(preview, /--alias="\$PLATFORM_ALIAS"/);
  assert.doesNotMatch(preview, /--prod/);
});

test('preview retains its exact bundle and smoke evidence even when verification fails', () => {
  assert.match(preview, /name: platform-preview-dist-\$\{\{ github.sha \}\}/);
  assert.match(preview, /COMMIT_REF: \$\{\{ github.sha \}\}/);
  assert.match(preview, /run: node scripts\/verify-platform-preview.mjs/);
  assert.match(preview, /if: always\(\)[\s\S]*path: evidence\/platform-\*\.json/);
  for (const flow of [preview, build]) {
    assert.match(flow, /scripts\/verify-platform-preview.test.mjs/);
    assert.match(flow, /scripts\/check-preview-ci.test.mjs/);
  }
});

test('release-only changes trigger every required preview workflow on push and PR', () => {
  const fullTriggers = fullCI.split('permissions:')[0];
  const policyTriggers = policy.split('permissions:')[0];
  for (const triggers of [fullTriggers, policyTriggers]) {
    assert.match(triggers, /^  push:/m);
    assert.match(triggers, /^  pull_request:/m);
  }
  for (const path of [
    "'scripts/**'",
    "'.github/workflows/publish-platform-preview.yml'",
    "'.github/workflows/test-memberwebsocket-dev.yml'",
  ]) {
    assert.equal(fullTriggers.split(path).length - 1, 1, `full CI push: ${path}`);
    assert.equal(policyTriggers.split(path).length - 1, 1, `policy push: ${path}`);
  }
  for (const triggers of [fullTriggers, policyTriggers]) {
    const prSettings = triggers.slice(triggers.indexOf('  pull_request:')).split('\n').slice(1).join('\n').split(/^  [\w-]+:/m)[0];
    assert.doesNotMatch(prSettings, /^\s+(?:paths|paths-ignore|branches|branches-ignore):/m);
  }
  assert.match(policy, /'feature\/productization-super-admin'/);
  assert.match(preview.split('permissions:')[0], /'\.github\/workflows\/test-memberwebsocket-dev\.yml'/);
});

test('integrated preview verifies the CI-gated native branch without a conflicting ZIP publisher', () => {
  const sourceBranch = 'if [ "$GITHUB_REF_NAME" = Integrated-Marketing-Platform ]; then';
  const inspect = 'node scripts/inspect-preview-source.mjs';
  const native = 'node scripts/verify-netlify-native-preview.mjs';
  const ci = 'node scripts/check-preview-ci.mjs';
  const netlify = readFileSync(new URL('../scripts/netlify-preview-source.mjs', import.meta.url), 'utf8');
  assert.ok(preview.includes(sourceBranch));
  assert.ok(preview.includes("'integrated-marketing-platform' || 'platform'"));
  assert.ok(preview.indexOf(ci) < preview.indexOf(inspect));
  assert.ok(preview.indexOf(inspect) < preview.indexOf(native));
  assert.ok(preview.indexOf(native) < preview.indexOf('- name: Build and verify the exact platform frontend'));
  assert.ok(preview.includes('VERIFIED_PREVIEW_SOURCE_EPOCH=$(git show -s --format=%ct'));
  assert.ok(preview.includes('DEPLOY_ID=$(jq -er'));
  assert.ok(preview.includes('zip -qr ../evidence/platform-preview.zip'));
  assert.ok(preview.includes('test "$current" = "$GITHUB_SHA"'));
  assert.ok(preview.includes(`test "$(jq -er '.source_sha' evidence/platform-deploy.json)" = "$GITHUB_SHA"`));
  assert.ok(preview.includes(`test "$(jq -er '.production_deploy_unchanged' evidence/platform-deploy.json)" = "true"`));
  const nativeClause = preview.slice(preview.indexOf(sourceBranch), preview.indexOf('          else', preview.indexOf(sourceBranch)));
  assert.ok(!nativeClause.includes('netlify-cli@'), 'No Draft alias may replace this native Git branch');
  assert.ok(!nativeClause.includes('netlify-preview-source.mjs --publish'), 'Native branch must have exactly one publisher');
  assert.ok(nativeClause.includes('node scripts/verify-netlify-native-preview.mjs'));
  assert.ok(!nativeClause.includes('--prod'), 'Integrated branch must never publish production');
  assert.ok(preview.indexOf(native, preview.indexOf(sourceBranch)) < preview.indexOf('cat evidence/platform-deploy.json'));
  assert.ok(netlify.includes('awaitVerifiedPreviewCI'), 'Netlify native build must require exact SHA CI');
  assert.ok(netlify.includes('isNativeVerifiedPreview(process.env)'), 'Only native branch build may use its CI gate');
  assert.ok(preview.includes("redirects = [] if os.environ['GITHUB_REF_NAME'] == 'Integrated-Marketing-Platform'"));
  assert.ok(preview.includes("config['redirects']"));
  assert.ok(preview.includes("config['headers']"));
  assert.ok(preview.includes('dist/_headers'));
  assert.ok(!preview.includes('--prod'));
  const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.ok(config.includes('command = "node scripts/netlify-preview-source.mjs --build"'));
  assert.ok(config.includes('ignore = "node ./scripts/netlify-preview-source.mjs --ignore"'));
  for (const source of [preview, build]) {
    assert.ok(source.includes('scripts/netlify-preview-source.test.mjs'));
    assert.ok(source.includes('scripts/inspect-preview-source.test.mjs'));
    assert.ok(source.includes('scripts/netlify-native-ci-gate.test.mjs'));
    assert.ok(source.includes('scripts/verify-netlify-native-preview.test.mjs'));
  }
});
