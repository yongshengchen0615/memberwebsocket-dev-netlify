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

test('integrated branch recovers native builds only after the exact-SHA CI and keeps production isolated',()=>{
 const ci='node scripts/check-preview-ci.mjs';
 const inspect='node scripts/inspect-preview-source.mjs';
 const native='node scripts/verify-netlify-native-preview.mjs';
 const nativeSource=readFileSync(new URL('../scripts/netlify-preview-source.mjs',import.meta.url),'utf8');
 const gate=readFileSync(new URL('../scripts/netlify-native-ci-gate.mjs',import.meta.url),'utf8');
 assert.ok(preview.indexOf(ci)<preview.indexOf(inspect));
 assert.ok(preview.indexOf(inspect)<preview.indexOf(native));
 assert.match(preview,/grep -Fxq 'Verified native branch preview failed: NATIVE_DEPLOY_FAILED'/);
 assert.match(preview,/grep -Fxq 'Verified native branch preview failed: DEPLOY_NOT_READY'/);
 assert.match(preview,/grep -Fxq 'Verified native branch preview failed: NATIVE_ALIAS_STALE'/);
 assert.match(preview,/env:set PLATFORM_CI_VERIFIED_SHA "\$GITHUB_SHA"/);
 assert.match(preview,/--context "branch:\$GITHUB_REF_NAME" --scope builds --force/);
 assert.match(preview,/--request POST --data '\{\}'/);
 assert.ok(preview.includes('/builds?branch=$GITHUB_REF_NAME&commit_sha=$GITHUB_SHA'));
 assert.ok(preview.includes('NATIVE_NOT_BEFORE'));
 assert.ok(preview.includes('PREVIEW_DEPLOY_MODE=native'));
 assert.doesNotMatch(preview,/PREVIEW_DEPLOY_MODE=ci-zip/);
 assert.doesNotMatch(preview,/netlify-preview-source\\.mjs --publish/);
 assert.doesNotMatch(preview,/--prod/);
 assert.ok(preview.includes('VERIFIED_PREVIEW_SOURCE_EPOCH=$(git show -s --format=%ct'));
 assert.ok(preview.includes('test "$current" = "$GITHUB_SHA"'));
 assert.ok(preview.includes(`test "$(jq -er '.source_sha' evidence/platform-deploy.json)" = "$GITHUB_SHA"`));
 assert.ok(preview.includes(`test "$(jq -er '.production_deploy_unchanged' evidence/platform-deploy.json)" = "true"`));
 assert.ok(preview.includes('node scripts/verify-platform-preview.mjs'));
 assert.ok(preview.includes('Run read-only Chromium preview acceptance'));
 assert.ok(nativeSource.includes('isNativeVerifiedPreview(process.env)'));
 assert.ok(nativeSource.includes('hasCiAttestedReleaseMarker(process.env)'));
 assert.ok(nativeSource.includes('awaitVerifiedPreviewCI'));
 assert.ok(gate.includes('env.NETLIFY === \'true\''));
 assert.ok(gate.includes('env.PLATFORM_CI_VERIFIED_SHA === env.COMMIT_REF'));
});

test('missing native branch deploy recovers only through exact-SHA CI-attested branch build',()=>{
 const ci=preview.indexOf('node scripts/check-preview-ci.mjs');
 const inspect=preview.indexOf('- name: Inspect platform source and pin release timestamp');
 const build=preview.indexOf('- name: Build and verify the exact platform frontend');
 const recovery=preview.slice(inspect,build);
 const guard=recovery.slice(recovery.indexOf('elif grep -Fxq'),recovery.indexOf('; then',recovery.indexOf('elif grep -Fxq')));
 assert.ok(ci>=0 && ci<inspect && inspect<build);
 assert.match(guard,/NATIVE_DEPLOY_FAILED/);
 assert.match(guard,/DEPLOY_NOT_READY/);
 assert.match(guard,/\|\|\s*grep -Fxq/);
 assert.doesNotMatch(guard,/PROVIDER_UNAVAILABLE|DEPLOY_IDENTITY_MISMATCH|PRODUCTION_IDENTITY_CHANGED/);
 assert.ok(recovery.indexOf('env:set PLATFORM_CI_VERIFIED_SHA "$GITHUB_SHA"')>recovery.indexOf('elif grep -Fxq'));
 assert.ok(recovery.indexOf('--request POST --data')>recovery.indexOf('env:set PLATFORM_CI_VERIFIED_SHA'));
 assert.ok(recovery.includes('commit_sha=$GITHUB_SHA'));
 assert.ok(recovery.includes('test "$GITHUB_REF_NAME" = Integrated-Marketing-Platform'));
 assert.ok(recovery.includes('node scripts/verify-netlify-native-preview.mjs'));
});

test('pre-CI native failure cannot be mistaken for a successful release',()=>{
 const before=preview.slice(preview.indexOf('- name: Inspect platform source and pin release timestamp'),
   preview.indexOf('- name: Build and verify the exact platform frontend'));
 assert.ok(before.includes('node scripts/inspect-preview-source.mjs'));
 assert.ok(before.includes('if node scripts/verify-netlify-native-preview.mjs'));
 assert.ok(before.includes('elif grep -Fxq'));
 assert.ok(before.indexOf('env:set PLATFORM_CI_VERIFIED_SHA') > before.indexOf('elif grep -Fxq'));
 assert.ok(before.indexOf('node scripts/verify-netlify-native-preview.mjs',before.indexOf('--request POST'))>before.indexOf('--request POST'));
 assert.ok(before.includes('exit 1'));
 const build=preview.slice(preview.indexOf('- name: Build and verify the exact platform frontend'),
   preview.indexOf('- name: Retain the exact preview bundle for recovery'));
 assert.ok(build.includes('test "$PREVIEW_DEPLOY_MODE" = native'));
 assert.ok(build.includes('test -n "$DEPLOY_ID"'));
 assert.doesNotMatch(build,/unset VERIFIED_PREVIEW_SOURCE_EPOCH/);
 assert.ok(build.indexOf('test -n "$DEPLOY_ID"')<build.indexOf('node scripts/build-site.mjs'));
});

test('post-CI native recovery keeps shell continuation and the other preview branch contract',()=> {
  const recovery=preview.slice(
    preview.indexOf("elif grep -Fxq 'Verified native branch preview failed"),
    preview.indexOf('\n          else\n',preview.indexOf("elif grep -Fxq 'Verified native branch preview failed")));
  assert.ok(recovery.length>200);
  assert.equal(recovery.includes(String.fromCharCode(92,92,10)),false,'No doubled Bash line-continuation backslashes');
  for (const fragment of ['env:set PLATFORM_CI_VERIFIED_SHA', '--scope builds --force',
    "curl --fail --silent --show-error --retry 0", '--header "Authorization: Bearer $NETLIFY_AUTH_TOKEN"',
    '--request POST --data', '--output /tmp/native-recovery-build.json']) assert.ok(recovery.includes(fragment),fragment);
  assert.ok(recovery.includes(String.fromCharCode(92,10)),'Multiline commands use single backslash/newline');

  const buildStep=preview.slice(preview.indexOf('- name: Build and verify the exact platform frontend'),
    preview.indexOf('- name: Retain the exact preview bundle for recovery'));
  assert.match(buildStep,/if \[ "\$GITHUB_REF_NAME" = Integrated-Marketing-Platform \]; then/);
  assert.match(buildStep,/test "\$PREVIEW_DEPLOY_MODE" = native/);
  assert.match(buildStep,/test -n "\$DEPLOY_ID"/);
  assert.ok(buildStep.indexOf('fi')>buildStep.indexOf('test -n "$DEPLOY_ID"'));
  assert.ok(preview.includes('npx --yes netlify-cli@23.11.0 deploy --no-build --dir=dist --site="$NETLIFY_SITE_ID" --alias="$PLATFORM_ALIAS"'));
});

test('both attested and GitHub-API native build paths derive source epoch from validated commit',()=>{
  const src=readFileSync(new URL('../scripts/netlify-preview-source.mjs',import.meta.url),'utf8');
  const buildCode=src.slice(src.indexOf("else if (mode === '--build')"),src.indexOf("} else if (mode === '--publish')"));
  assert.ok(buildCode.includes('hasCiAttestedReleaseMarker(process.env)'));
  assert.ok(buildCode.includes('awaitVerifiedPreviewCI'));
  assert.ok(buildCode.includes("['show', '-s', '--format=%ct', process.env.COMMIT_REF]"));
  assert.doesNotMatch(buildCode,/format=%ct', verified\.sha/);
});


test('stale public alias is recoverable only after exact SHA CI and final acceptance rechecks the live version',()=>{
 const ci=preview.indexOf('node scripts/check-preview-ci.mjs');
 const release=preview.indexOf('node scripts/inspect-preview-source.mjs');
 const recovery=preview.indexOf("grep -Fxq 'Verified native branch preview failed: NATIVE_ALIAS_STALE'");
 const build=preview.indexOf('curl --fail --silent --show-error --retry 0');
 const browser=preview.indexOf('- name: Run read-only Chromium preview acceptance');
 const final=preview.indexOf('- name: Final exact-SHA branch alias and asset verification after browser acceptance');
 const evidence=preview.indexOf('- name: Retain preview browser HTML');
 assert.ok(ci>=0 && ci<release && release<recovery && recovery<build);
 assert.ok(browser>=0 && browser<final && final<evidence);
 const finalStep=preview.slice(final,evidence);
 assert.match(finalStep,/test "\$current" = "\$GITHUB_SHA"/);
 assert.match(finalStep,/node scripts\/verify-netlify-native-preview\.mjs/);
 assert.match(finalStep,/node scripts\/verify-platform-preview\.mjs/);
 assert.match(finalStep,/\.source_sha' evidence\/platform-deploy\.json/);
 assert.match(finalStep,/\.deploy_id' evidence\/platform-deploy\.json/);
 const verifier=readFileSync(new URL('../scripts/verify-netlify-native-preview.mjs',import.meta.url),'utf8');
 assert.match(verifier,/NATIVE_ALIAS_STALE/);
 assert.match(verifier,/NATIVE_SIBLING_BUILD_PENDING/);
 assert.match(verifier,/native_release_check/);
 assert.match(verifier,/data-commit/);
 assert.doesNotMatch(preview,/--prod\b/);
});

test('AC-NATIVE-ENV-001: native recovery uses NETLIFY_SITE_ID without unsupported env:set --site flag',()=>{
  const command=preview.match(/npx --yes netlify-cli@23\.11\.0 env:set PLATFORM_CI_VERIFIED_SHA[\s\S]*?--force/);
  assert.ok(command,'native recovery must pin verified SHA before starting a branch build');
  assert.match(preview,/NETLIFY_SITE_ID: 196e1d2c-8216-4ba8-aeb9-1706660adc2b/);
  assert.match(command[0],/--context "branch:\$GITHUB_REF_NAME"/);
  assert.match(command[0],/--scope builds --force/);
  assert.doesNotMatch(command[0],/--site(?:=|\s)/,'env:set reads site from NETLIFY_SITE_ID instead');
});
