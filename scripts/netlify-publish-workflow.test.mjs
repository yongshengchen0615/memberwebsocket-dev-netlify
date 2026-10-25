import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('production deploy targets only the existing Netlify site with protected credentials', () => {
  assert.match(flow, /NETLIFY_SITE_ID: 23796c62-480a-4b46-ac90-bfbc5ad4d300/);
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

test('deployment changes trigger the same full suite on PR and develop push', () => {
  const sources = fullCI.split('  pull_request:');
  assert.equal(sources.length, 2);
  for (const source of sources) {
    assert.match(source, /'\.github\/workflows\/publish-netlify\.yml'/);
    assert.match(source, /'scripts\/\*\*'/);
  }
});

test('preview uses the latest exact-commit CI gate before publishing and preserves alias scope', () => {
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
  for (const workflow of [fullCI, policy]) {
    const triggers = workflow.split('permissions:')[0];
    assert.equal((triggers.match(/'scripts\/\*\*'/g) || []).length, 2);
    assert.equal((triggers.match(/'\.github\/workflows\/publish-platform-preview.yml'/g) || []).length, 2);
    assert.equal((triggers.match(/'\.github\/workflows\/test-memberwebsocket-dev.yml'/g) || []).length, 2);
  }
  assert.match(policy, /'feature\/productization-super-admin'/);
  assert.match(preview.split('permissions:')[0], /'\.github\/workflows\/test-memberwebsocket-dev.yml'/);
});

test('integrated preview verifies the CI-gated native branch instead of a colliding Draft alias', () => {
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
  assert.ok(preview.includes("redirects = [] if os.environ['GITHUB_REF_NAME'] == 'Integrated-Marketing-Platform'"), 'Native recovery bundle must retain the verified root HTTP 200 contract');
  assert.ok(preview.indexOf(native) < preview.indexOf('cat evidence/platform-deploy.json'));
  const nativeClause = preview.slice(preview.indexOf(sourceBranch), preview.indexOf('          else',preview.indexOf(sourceBranch)));
  assert.ok(!nativeClause.includes('netlify-cli@'), 'Integrated source must not upload an alias Draft');
  assert.ok(netlify.includes('awaitVerifiedPreviewCI'), 'Netlify native build must wait for exact-SHA CI');
  assert.ok(netlify.includes('isNativeVerifiedPreview(process.env)'), 'Only the native branch may use the gate');
  assert.ok(preview.includes('scripts/netlify-native-ci-gate.test.mjs'));
  assert.ok(preview.includes('scripts/verify-netlify-native-preview.test.mjs'));
  assert.ok(!preview.includes('--prod'));
  assert.ok(preview.includes("config['redirects']"));
  assert.ok(preview.includes("config['headers']"));
  assert.ok(preview.includes('dist/_headers'));
  assert.ok(preview.includes('zip -qr ../evidence/platform-preview.zip'));
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

test('legacy importer remains retired so it cannot overwrite reviewed sources', () => {
  // ARCH-01: the old import-source workflow copied a pinned, outdated repo tree
  // and directly pushed to main. Its removal must not regress.
  assert.equal(
    existsSync(new URL('../.github/workflows/import-source.yml', import.meta.url)),
    false,
    'Legacy import-source.yml must stay retired; use an independently reviewed PR instead',
  );
});
