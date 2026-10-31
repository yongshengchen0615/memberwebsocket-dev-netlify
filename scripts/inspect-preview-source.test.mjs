import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPreviewSource, summarizePreviewSource } from './inspect-preview-source.mjs';

const siteId = '196e1d2c-8216-4ba8-aeb9-1706660adc2b';
const site = { id: siteId, name: 'memberwebsocket-dev-netlify', build_settings: {
  provider: 'github', repo_path: 'yongshengchen0615/memberwebsocket-dev-netlify',
  repo_branch: 'main', allowed_branches: ['Integrated-Marketing-Platform'],
  cmd: 'node scripts/build-site.mjs', env: { SECRET: 'never-print-this' },
}, published_deploy: { id: '6ad34aa232fcb1cea452346f', commit_ref: 'a'.repeat(40) } };
const deploys = [
  { id: '6ad8954a695249e48e388cae', branch: 'integrated-marketing-platform', context: 'branch-deploy', state: 'ready', commit_ref: null, title: 'SECRET', env: { SECRET: 'never-print-this' } },
  { id: '6ad8954a695249e48e388caf', branch: 'Integrated-Marketing-Platform', context: 'branch-deploy', state: 'ready', commit_ref: 'b'.repeat(40), build_id: '6ad8954a695249e48e388cad' },
];

test('identifies competing native branch and alias sources without exporting secrets', () => {
  const result = summarizePreviewSource(site, deploys, { siteId, branch: 'Integrated-Marketing-Platform', alias: 'integrated-marketing-platform' });
  assert.equal(result.aliasMatchesGitBranch, true);
  assert.equal(result.nativeBranchDeployObserved, true);
  assert.equal(result.aliasDeployObserved, true);
  assert.equal(result.production.branch, 'main');
  assert.equal(result.build.staticCommand, true);
  assert.equal(result.deploys.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|never-print-this|NETLIFY_AUTH_TOKEN/);
});

test('does not invent branch deploy evidence from ready state alone', () => {
  const result = summarizePreviewSource(site, [deploys[0]], { siteId, branch: 'Integrated-Marketing-Platform', alias: 'integrated-marketing-platform' });
  assert.equal(result.nativeBranchDeployObserved, false);
  assert.equal(result.aliasDeployObserved, true);
});

test('rejects wrong site, malformed response and unsafe routing input', () => {
  const options = { siteId, branch: 'Integrated-Marketing-Platform', alias: 'integrated-marketing-platform' };
  assert.throws(() => summarizePreviewSource({ ...site, id: 'wrong' }, deploys, options), /site identity/);
  assert.throws(() => summarizePreviewSource(site, {}, options), /deploy list/);
  assert.throws(() => summarizePreviewSource(site, deploys, { ...options, alias: 'https://other.example' }), /routing/);
});

test('redacts unexpected text fields and does not return raw build commands', () => {
  const changed = structuredClone(site);
  changed.build_settings.cmd = 'echo never-print-this';
  changed.build_settings.repo_branch = 'token=never-print-this';
  const result = summarizePreviewSource(changed, deploys, { siteId, branch: 'Integrated-Marketing-Platform', alias: 'integrated-marketing-platform' });
  assert.equal(result.build.staticCommand, false);
  assert.equal(result.production.branch, null);
  assert.doesNotMatch(JSON.stringify(result), /never-print-this|echo/);
});

test('uses only authenticated read requests to the fixed Netlify API and refuses redirects', async () => {
  const calls = [];
  const result = await inspectPreviewSource({ token: 'test-secret', siteId, branch: 'Integrated-Marketing-Platform', alias: 'integrated-marketing-platform', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/deploys?per_page=100') ? deploys : site };
  } });
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://api.netlify.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
  }
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test('provider error bodies and missing credentials never reach diagnostic output', async () => {
  await assert.rejects(inspectPreviewSource({ token: '', siteId }), /credential/);
  await assert.rejects(inspectPreviewSource({ token: 'test-secret', siteId, branch: 'Integrated-Marketing-Platform', alias: 'integrated-marketing-platform', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'SECRET' }) }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /SECRET|test-secret/);
    return true;
  });
});
