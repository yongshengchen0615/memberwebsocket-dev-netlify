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
    if (options.method === 'POST') value = overrides.created || { id: deployId };
    else if (endpoint.pathname === `/api/v1/deploys/${deployId}`) value = overrides.deploy || deploy;
    else if (endpoint.pathname.endsWith('/deploys')) value = overrides.existing || [];
    else value = overrides.site || site;
    return { ok: true, json: async () => value };
  } };
}

test('native branch build proceeds, but wrong identity and production still fail closed', () => {
  const base = { NETLIFY: 'true', BRANCH: previewBranch, CONTEXT: 'branch-deploy' };
  assert.equal(blockNativePreview(base), false);
  assert.equal(blockNativePreview({ ...base, CONTEXT: 'production' }), true);
  assert.equal(blockNativePreview({ ...base, BRANCH: 'integrated-marketing-platform' }), true);
  assert.equal(blockNativePreview({ ...base, BRANCH: 'master', CONTEXT: 'production' }), true);
  for (const env of [{ ...base, BRANCH: 'develop' },
    { ...base, CONTEXT: 'deploy-preview' }, { ...base, NETLIFY: undefined }, {}]) assert.equal(blockNativePreview(env), false);
});

test('uploads exactly once to the case-preserved nonproduction branch and retains deployment identity', async () => {
  const p = provider();
  const result = await publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl });
  const posts = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  const url = new URL(posts[0].url);
  assert.equal(url.origin, 'https://api.netlify.com');
  assert.equal(url.pathname, `/api/v1/sites/${previewSite}/deploys`);
  // Direct ZIP uploads must not invoke a second Netlify build. The branch
  // query selects a nonproduction branch deploy, not the site's main branch.
  assert.equal(url.searchParams.get('branch'), previewBranch);
  assert.equal(url.searchParams.get('title'), `verified-platform-${input.commit}`);
  assert.equal(posts[0].options.headers['Content-Type'], 'application/zip');
  assert.ok(Buffer.isBuffer(posts[0].options.body));
  assert.deepEqual(posts[0].options.body, input.zip);
  assert.ok(p.calls.some(call => call.url.endsWith('/deploys/' + deployId)));
  assert.equal(result.source_sha, input.commit);
  assert.equal(result.production_deploy_unchanged, true);
  assert.doesNotMatch(JSON.stringify(result), /never-print-token/);
  for (const call of p.calls) assert.equal(call.options.redirect, 'error');
});

test('real Netlify ZIP canonicalization preserves verified GitHub scope and immutable deploy identity', async () => {
  const p = provider({ deploy: { ...deploy, branch: previewBranch.toLowerCase() } });
  const result = await publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl });
  assert.equal(result.source_branch, previewBranch, 'evidence retains canonical GitHub ref');
  assert.equal(result.source_sha, input.commit);
  assert.equal(result.context, 'branch-deploy');
  assert.equal(result.deploy_id, deployId);
  assert.equal(result.production_deploy_unchanged, true);
  const posts = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(new URL(posts[0].url).searchParams.get('branch'), previewBranch);
});

test('direct ZIP upload is never retried after a failed deploy', async () => {
  const p = provider({ deploy: { ...deploy, state: 'error' } });
  await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl }), /Preview deploy failed/);
  const posts = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].options.body, input.zip);
  assert.equal(posts[0].options.headers['Content-Type'], 'application/zip');
  assert.equal(new URL(posts[0].url).searchParams.get('branch'), previewBranch);
});

test('ZIP deploy response must identify exactly one immutable deploy before status polling', async () => {
  for (const created of [{}, { id: 'invalid' }, { deploy_id: deployId }, { id: '0'.repeat(24) }]) {
    const p = provider({ created });
    await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl }),
      created.id === '0'.repeat(24) ? /not belong/ : /deploy identity/);
    assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 1);
  }
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
    { existing: [{ ...deploy, state: 'building' }] },
    { existing: [{ ...deploy, branch: previewBranch.toLowerCase(), state: 'building' }] },
    { existing: {} }]) {
    const p = provider(changed);
    await assert.rejects(publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl }));
    assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('wrong branch, site or production context and terminal failures cannot pass readiness', async () => {
  for (const changed of [{ branch: 'master' }, { branch: 'INTEGRATED-MARKETING-PLATFORM' }, { branch: ' integrated-marketing-platform' }, { site_id: 'wrong' }, { context: 'production' }, { state: 'error' }, { state: 'canceled' }]) {
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

test('safe local publish errors give useful codes without logging provider-supplied content', () => {
  assert.match(describePreviewPublishFailure(new Error('Preview source or production branch identity changed')), /SOURCE_IDENTITY/);
  assert.match(describePreviewPublishFailure(new Error('A competing preview deployment is still active')), /ACTIVE_DEPLOY/);
  assert.match(describePreviewPublishFailure(new Error('Published deploy does not belong to the verified preview branch')), /WRONG_DEPLOY_SCOPE/);
  assert.match(describePreviewPublishFailure(new Error('Production identity changed during preview publication')), /PRODUCTION_CHANGED/);
  assert.doesNotMatch(describePreviewPublishFailure(new Error('secret provider body token=abc')), /secret provider|token=abc/);
});


test('Netlify direct ZIP deploy uses response id and cannot confuse it with build id', async () => {
  const p = provider({ created: { id: deployId, deploy_id: 'f'.repeat(24) } });
  const result = await publishPreviewBranch({ ...input, fetchImpl: p.fetchImpl });
  assert.equal(result.deploy_id, deployId);
  assert.equal(result.context, 'branch-deploy');
  const post = p.calls.find(call => call.options.method === 'POST');
  const query = new URL(post.url);
  assert.equal(query.pathname, `/api/v1/sites/${previewSite}/deploys`);
  assert.equal(query.searchParams.get('branch'), previewBranch);
  assert.equal(post.options.headers['Content-Type'], 'application/zip');
  assert.deepEqual(post.options.body, input.zip);
  assert.equal(p.calls.some(call => call.url.includes('/deploys/' + 'f'.repeat(24))), false);
});
