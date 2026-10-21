import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const path = new URL('../.github/workflows/publish-netlify.yml', import.meta.url);
const flow = readFileSync(path, 'utf8');
const fullCI = readFileSync(new URL('../.github/workflows/test-memberwebsocket-dev.yml', import.meta.url), 'utf8');
const previewFlow = readFileSync(new URL('../.github/workflows/publish-platform-preview.yml', import.meta.url), 'utf8');

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

test('preview smoke treats page, JS and config as one bounded CDN gate without weakening API authorization', () => {
  assert.match(previewFlow, /for attempt in \\$\\(seq 1 20\\)/);
  for (const flag of ['html_ok', 'js_ok', 'config_ok']) {
    assert.match(previewFlow, new RegExp(flag + '=0'));
    assert.match(previewFlow, new RegExp(flag + '=1'));
  }
  assert.match(previewFlow, /\\[\\[ "\\$html_ok" == 1 && "\\$js_ok" == 1 && "\\$config_ok" == 1 \\]\\]/);
  assert.match(previewFlow, /data-commit=/);
  assert.match(previewFlow, /platformLiffId/);
  assert.match(previewFlow, /test "\\$code" = 401/);
  assert.match(previewFlow, /AUTH_REQUIRED/);
  assert.match(previewFlow, /after 20 checks/);
});
