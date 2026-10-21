import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const path = new URL('../.github/workflows/publish-netlify.yml', import.meta.url);
const flow = readFileSync(path, 'utf8');
const fullCI = readFileSync(new URL('../.github/workflows/test-memberwebsocket-dev.yml', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../.github/workflows/publish-platform-preview.yml', import.meta.url), 'utf8');
const build = readFileSync(new URL('../.github/workflows/test-netlify-build.yml', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../.github/workflows/test-memberwebsocket-ticket-policy.yml', import.meta.url), 'utf8');

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

test('deployment changes trigger the full suite for develop push and every pull request', () => {
  const sections = fullCI.split('  pull_request:');
  assert.equal(sections.length, 2);
  assert.ok(sections[0].includes("'.github/workflows/publish-netlify.yml'"));
  assert.ok(sections[0].includes("'scripts/**'"));
  const prSettings = sections[1].split('permissions:')[0];
  // An unrestricted PR trigger covers release-only changes and every other file.
  assert.doesNotMatch(prSettings, /^\s+(?:paths|paths-ignore|branches|branches-ignore):/m);
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
  const fullTriggers = fullCI.split('permissions:')[0];
  const policyTriggers = policy.split('permissions:')[0];
  for (const triggers of [fullTriggers, policyTriggers]) {
    assert.match(triggers, /^  push:/m);
    assert.match(triggers, /^  pull_request:/m);
  }
  // Full CI now tests every pull request; only push needs a path allowlist.
  assert.equal((fullTriggers.match(/'scripts\/\*\*'/g) || []).length, 1);
  assert.equal((fullTriggers.match(/'\.github\/workflows\/publish-platform-preview.yml'/g) || []).length, 1);
  const fullPrConfig = fullTriggers.slice(fullTriggers.indexOf('  pull_request:'));
  assert.doesNotMatch(fullPrConfig, /^\s+(?:paths|paths-ignore|branches|branches-ignore):/m);
  // Ticket-policy workflow still requires release paths in both event filters.
  assert.equal((policyTriggers.match(/'scripts\/\*\*'/g) || []).length, 2);
  assert.equal((policyTriggers.match(/'\.github\/workflows\/publish-platform-preview.yml'/g) || []).length, 2);
  assert.match(policy, /'feature\/productization-super-admin'/);
});

test('the integrated preview uses a real branch ZIP after CI and retains global routing and headers', () => {
  assert.match(preview, /if \[ "\$GITHUB_REF_NAME" = Integrated-Marketing-Platform \]; then\s+node scripts\/inspect-preview-source.mjs\s+node scripts\/netlify-preview-source.mjs --publish\s+else/);
  assert.ok(preview.indexOf('node scripts/check-preview-ci.mjs') < preview.indexOf('node scripts/netlify-preview-source.mjs --publish'));
  assert.match(preview, /config\['redirects'\]/);
  assert.match(preview, /config\['headers'\]/);
  assert.match(preview, /dist\/_headers/);
  assert.match(preview, /zip -qr ..\/evidence\/platform-preview.zip/);
  const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(config, /command = "node scripts\/netlify-preview-source.mjs --build"/);
  assert.match(config, /ignore = "node .\/scripts\/netlify-preview-source.mjs --ignore"/);
  for (const source of [preview, build]) {
    assert.match(source, /scripts\/netlify-preview-source.test.mjs/);
    assert.match(source, /scripts\/inspect-preview-source.test.mjs/);
  }
});
