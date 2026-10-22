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
  }
  assert.match(policy, /'feature\/productization-super-admin'/);
});

test('integrated preview publishes an isolated CLI draft after CI with exact bundle and smoke evidence', () => {
  const branch = 'if [ "$GITHUB_REF_NAME" = Integrated-Marketing-Platform ]; then';
  const inspect = 'node scripts/inspect-preview-source.mjs';
  const publish = 'npx --yes netlify-cli@23.11.0 deploy --no-build --dir=dist --site="$NETLIFY_SITE_ID" --alias="$PLATFORM_ALIAS"';
  const verify = 'node scripts/verify-netlify-cli-preview.mjs /tmp/platform-deploy.json';
  assert.ok(preview.includes(branch), 'Explicit branch guard is required');
  assert.ok(preview.includes("'verified-integrated-platform' || 'platform'"), 'Alias must not collide with a Git branch');
  assert.ok(preview.includes('scripts/verify-netlify-cli-preview.test.mjs'), 'Verifier tests must run in release');
  assert.ok(preview.indexOf('node scripts/check-preview-ci.mjs') < preview.indexOf(inspect));
  assert.ok(preview.indexOf(inspect) < preview.indexOf(publish));
  assert.ok(preview.indexOf(publish) < preview.indexOf(verify));
  assert.ok(preview.indexOf(verify) < preview.indexOf('cat evidence/platform-deploy.json'));
  assert.ok(!preview.includes('node scripts/netlify-preview-source.mjs --publish'), 'Do not use the failed raw ZIP upload route');
  assert.ok(!preview.includes('--prod'), 'Never deploy preview as production');
  assert.match(preview, /config\\['redirects'\\]/);
  assert.match(preview, /config\\['headers'\\]/);
  assert.match(preview, /dist\\/_headers/);
  assert.match(preview, /zip -qr ..\\/evidence\\/platform-preview.zip/);
  const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(config, /command = "node scripts\\/netlify-preview-source.mjs --build"/);
  assert.match(config, /ignore = "node .\\/scripts\\/netlify-preview-source.mjs --ignore"/);
  for (const source of [preview, build]) {
    assert.ok(source.includes('scripts/netlify-preview-source.test.mjs'));
    assert.ok(source.includes('scripts/inspect-preview-source.test.mjs'));
  }
});
