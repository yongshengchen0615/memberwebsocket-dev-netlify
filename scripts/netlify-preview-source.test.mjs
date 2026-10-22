import test from 'node:test';
import assert from 'node:assert/strict';
import { blockNativePreview, publishPreviewBranch, previewSite, previewBranch, describePreviewPublishFailure, PreviewProviderError } from './netlify-preview-source.mjs';

const site = { id: previewSite, name: 'memberwebsocket-dev-netlify', build_settings: {
  repo_path: 'yongshengchen0615/memberwebsocket-dev-netlify', repo_branch: 'master',
}, published_deploy: { id: '6ad34aa232fcb1cea452346f' } };
const deployId = '6ad8954a695249e48e388cae';
const deploy = { id: deployId, site_id: previewSite, branch: previewBranch, context: 'branch-deploy', state: 'ready' };
const input = { token: 'never-print-token', siteId: previewSite, branch: previewBranch, commit: 'a'.repeat(40), zip: Buffer.from([80, 75, 3, 4, 1]) };
function provider(overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const endpoint = new URL(url);
    let value;
    if (options.method === 'POST') value = overrides.build || { deploy_id: deployId };
    else if (endpoint.pathname === `/api/v1/deploys/${deployId}`) value = overrides.deploy || deploy;
    else if (endpoint.pathname.endsWith('/deploys')) value = overrides.existing || [];
    else value = overrides.site || site;
    return { ok: true, json: async () => value };
  } };
}

test('native branch and hook publication is blocked while production and PR previews retain builds', () => {
  const base = { NETLIFY: 'true', BRANCH: previewBranch, CONTEXT: 'branch-deploy' };
  assert.equal(blockNativePreview(base), true);
  assert.equal(blockNativePreview({ ...base, CONTEXT: 'production' }), true);
  assert.equal(blockNativePreview({ ...base, BRANCH: 'integrated-marketing-platform' }), true);
  for (const env of [{ ...base, BRANCH: 'master', CONTEXT: 'production' }, { ...base, BRANCH: 'develop' },
    { ...base, CONTEXT: 'deploy-preview' }, { ...base, NETLIFY: undefined }, {}]) assert.equal(blockNativePreview(env), false);
});

test('uploads exactly once to the case-preserved nonproduction branch and retains deployment identity', async () => {
  const p = provider();
  const result = await publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl });
  const posts = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  const url = new URL(posts[0].url);
  assert.equal(url.origin, 'https://api.netlify.com');
  assert.equal(url.pathname, `/api/v1/sites/${previewSite}/builds`);
  assert.equal(url.searchParams.get('branch'), previewBranch);
  assert.equal(url.searchParams.get('title'), `verified-platform-${input.commit}`);
  assert.equal(posts[0].options.body, input.zip);
  assert.equal(posts[0].options.headers['Content-Type'], 'application/zip');
  assert.equal(result.source_sha, input.commit);
  assert.equal(result.production_deploy_unchanged, true);
  assert.doesNotMatch(JSON.stringify(result), /never-print-token/);
  for (const call of p.calls) assert.equal(call.options.redirect, 'error');
});

test('missing branch, other site, wrong commit or invalid ZIP cannot make any API request', async () => {
  for (const changed of [{ branch: '' }, { branch: 'master' }, { branch: 'integrated-marketing-platform' },
    { siteId: 'other' }, { commit: 'short' }, { token: '' }, { zip: Buffer.from('not-a-zip') }]) {
    const p = provider();
    await assert.rejects(publishPreviewBranch({ ...input, ...changed, fetchImpl: p.fetchImpl }));
    assert.equal(p.calls.length, 0);
  }
});

test('production collision, changed repository and active competing publisher prevent POST', async () => {
  for (const changed of [{ site: { ...site, build_settings: { ...site.build_settings, repo_branch: previewBranch.toLowerCase() } } },
    { site: { ...site, build_settings: { ...site.build_settings, repo_path: 'another/repo' } } },
    { existing: [{ ...deploy, state: 'building' }] }, { existing: {} }]) {
    const p = provider(changed);
    await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl }));
    assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('wrong branch, site or production context and terminal failures cannot pass readiness', async () => {
  for (const changed of [{ branch: 'integrated-marketing-platform' }, { site_id: 'wrong' }, { context: 'production' }, { state: 'error' }, { state: 'canceled' }]) {
    const p = provider({ deploy: { ...deploy, ...changed } });
    await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl }));
    assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('pending deploy uses bounded polling without repeating an upload', async () => {
  const p = provider({ deploy: { ...deploy, state: 'processing' } });
  const waits = [];
  await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl, delay: async ms => waits.push(ms), attempts: 2 }), /deadline/);
  assert.deepEqual(waits, [3000]);
  assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('an ambiguous upload timeout is never retried and raw provider error is not read', async () => {
  const p = provider(); let posts = 0;
  await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('timeout'); }
    return p.fetchImpl(url, options);
  } }), /timeout/);
  assert.equal(posts, 1);
  await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: async () => ({ ok: false, status: 403,
    json: async () => { throw new Error('provider body must not be read'); } }) }), /HTTP 403/);
});

test('a production change detected after upload prevents a successful result', async () => {
  const p = provider(); let reads = 0;
  await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: async (url, options) => {
    if (url.endsWith(`/sites/${previewSite}`) && ++reads === 2) return { ok: true,
      json: async () => ({ ...site, published_deploy: { id: 'changed' } }) };
    return p.fetchImpl(url, options);
  } }), /Production identity changed/);
});

test('publish errors identify the failing provider phase without echoing secrets or response bodies', async () => {
  const stages = ['site', 'deploy-list', 'upload', 'deploy-status', 'production'];
  for (let failAt = 1; failAt <= stages.length; failAt++) {
    const p = provider();
    let count = 0;
    await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: async (url, options) => {
      if (++count === failAt) return { ok: false, status: 422,
        json: async () => { throw new Error('private provider response: never read'); } };
      return p.fetchImpl(url, options);
    } }), error => {
      assert.equal(error instanceof PreviewProviderError, true);
      const message = describePreviewPublishFailure(error);
      assert.equal(message, `Verified preview publication failed during ${stages[failAt - 1]}: HTTP 422. Inspect deployment state before retrying. Provider bodies and credentials were not logged.`);
      assert.doesNotMatch(message, /private provider response|never-print-token/);
      return true;
    });
  }
  assert.match(describePreviewPublishFailure(new Error('secret full Netlify error body')), /unclassified/);
  assert.doesNotMatch(describePreviewPublishFailure(new Error('secret full Netlify error body')), /secret full/);
  assert.match(describePreviewPublishFailure(new PreviewProviderError('bad phase with token', 777)), /unclassified: HTTP unknown/);
});

test('opaque failures report the last trusted publisher stage without revealing provider errors', async () => {
  const phases = [];
  let captured;
  await assert.rejects(publishPreviewBranch({ ...input, onPhase: phase => phases.push(phase),
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') throw new Error('private provider credential in transport error');
      return provider().fetchImpl(url, options);
    } }), error => { captured = error; return true; });
  assert.equal(phases.at(-1), 'upload');
  const report = describePreviewPublishFailure(captured, phases.at(-1));
  assert.match(report, /during upload \(unclassified\)/);
  assert.doesNotMatch(report, /private provider credential/);
  assert.deepEqual(phases, ['input', 'site', 'site-identity', 'deploy-list', 'deploy-list-validation', 'upload']);
});

test('semantic publisher failures retain a safe stage but never provider metadata', async () => {
  for (const scenario of [
    { options: { build: {} }, phase: 'upload-response' },
    { options: { deploy: { ...deploy, context: 'production' } }, phase: 'deploy-identity' },
    { options: { site: { ...site, build_settings: { ...site.build_settings, repo_path: 'other/repo' } } }, phase: 'site-identity' },
  ]) {
    const phases = [];
    let captured;
    const p = provider(scenario.options);
    await assert.rejects(publishPreviewBranch({ ...input, onPhase: stage => phases.push(stage), fetchImpl: p.fetchImpl }),
      error => { captured = error; return true; });
    assert.equal(phases.at(-1), scenario.phase);
    const report = describePreviewPublishFailure(captured, phases.at(-1));
    assert.match(report, new RegExp('during ' + scenario.phase + ' \\(unclassified\\)'));
    assert.doesNotMatch(report, /other\/repo|never-print-token/);
  }
  assert.match(describePreviewPublishFailure(new Error('secret'), 'unsafe provider message'), /during unclassified/);
});
