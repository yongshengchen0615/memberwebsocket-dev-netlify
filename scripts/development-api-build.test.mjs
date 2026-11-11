import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'evidence/api-build-'));
fs.mkdirSync(path.join(fixture, 'scripts'));
for (const name of ['build-site.mjs', 'build-version.mjs', 'preview-member-runtime.mjs']) {
  fs.copyFileSync(path.join(root, 'scripts', name), path.join(fixture, 'scripts', name));
}
fs.cpSync(path.join(root, 'MemberWebsocket-dev'), path.join(fixture, 'MemberWebsocket-dev'), {
  recursive: true, filter: file => !file.split(path.sep).includes('node_modules'),
});
const sourceConfig = path.join(fixture, 'MemberWebsocket-dev/config.json');
const config = JSON.parse(fs.readFileSync(sourceConfig, 'utf8'));
const extra = path.join(fixture, 'MemberWebsocket-dev/member/obsolete-api.js');
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
function build() {
  return spawnSync(process.execPath, ['scripts/build-site.mjs'], {
    // This fixture tests a production build. Do not inherit the CI source
    // branch and accidentally combine Integrated with production identity.
    cwd: fixture, encoding: 'utf8', env: { ...process.env, BRANCH: 'master', CONTEXT: 'production' },
  });
}

test('AC-005: public build rejects retired API routes and resurrected preview switches', () => {
  try {
  for (const source of [
    "fetch('/functions/v1/test-mode-api')",
    "fetch('/functions/v1/test-control-api')",
    "fetch('/functions/v1/user-test-api')",
    "fetch('/functions/v1/e2e-artifact-api')",
    "fetch('/functions/v1/e2e-artifact-retention')",
    "fetch('/functions/v1/booking-api-preview')",
    "const route = config.bookingPreviewApis ? 'legacy' : 'canonical'",
    'const route = config.previewApiFunctionUrl',
  ]) {
    fs.writeFileSync(extra, source);
    const result = build();
    assert.notEqual(result.status, 0, source);
    assert.match(result.stderr, /Retired API routing in public asset: member\/obsolete-api.js/);
  }
  } finally { fs.rmSync(extra, { force: true }); }
});

test('AC-005: runtime config cannot publish a preview or retired API URL', () => {
  try {
  for (const name of ['api-preview', 'test-mode-api', 'e2e-artifact-api']) {
    fs.writeFileSync(sourceConfig, JSON.stringify({ ...config, supabaseFunctionUrl: config.supabaseUrl + '/functions/v1/' + name }));
    const result = build();
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /Retired API routing in runtime config: supabaseFunctionUrl/);
  }
  } finally { fs.writeFileSync(sourceConfig, JSON.stringify(config)); }
});

test('AC-005: real canonical frontend builds, preserves project identity and excludes QA assets', () => {
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(fs.readFileSync(path.join(fixture, 'dist/config.json'), 'utf8'));
  assert.equal(output.supabaseUrl, config.supabaseUrl);
  assert.equal(output.supabaseFunctionUrl, config.supabaseFunctionUrl);
  for (const file of ['test-mode-client.js', 'user-test-control.js', 'admin/test-mode.js', 'admin/test-control.js']) {
    assert.equal(fs.existsSync(path.join(fixture, 'dist', file)), false, file);
  }
});
