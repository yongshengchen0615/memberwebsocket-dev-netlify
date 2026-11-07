import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCliPreview, PreviewValidationError, siteId, siteName, previewAlias, previewBranch } from './verify-netlify-cli-preview.mjs';

const commit = 'a'.repeat(40);
const current = '6ad34aa232fcb1cea452346f';
const deployId = '6ad8954a695249e48e388cae';
const source = { siteId, branch: previewBranch, production: { branch: 'master', deployId: current },
  build: { repository: 'yongshengchen0615/memberwebsocket-dev-netlify' }, alias: previewAlias, aliasDeployObserved: true, deploys: [] };
const cli = { deploy_id: deployId, deploy_url: `https://${previewAlias}--${siteName}.netlify.app` };
const deployed = { id: deployId, site_id: siteId, state: 'ready', context: 'branch-deploy', branch: previewAlias };
const site = { id: siteId, name: siteName, published_deploy: { id: current },
  build_settings: { repo_branch: 'master', repo_path: 'yongshengchen0615/memberwebsocket-dev-netlify' } };
const input = { cli, source, token: 'secret-token-never-print', commit, branch: previewBranch, alias: previewAlias };
function mocked({ deploy = deployed, project = site } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({url,options});
    const response = url.endsWith('/' + deployId) ? deploy : project;
    return { ok: true, json: async () => response };
  } };
}
const rejects = (value, code) => assert.rejects(value, e => e instanceof PreviewValidationError && e.code === code);

test('existing CLI alias is approved while native branch publishing remains blocked', () => {
  assert.equal(previewAlias, previewBranch.toLowerCase());
  assert.ok(previewAlias.length <= 37);
});

test('one upload is outside this validator; read-only provider calls and exact SHA are enforced', async () => {
  const m = mocked();
  const result = await verifyCliPreview({ ...input, fetchImpl: m.fetchImpl });
  assert.equal(result.source_sha, commit);
  assert.equal(result.production_deploy_unchanged, true);
  assert.equal(result.deploy_id, deployId);
  assert.equal(result.deploy_url, cli.deploy_url);
  assert.equal(result.context, 'branch-deploy');
  assert.equal(m.calls.length, 2);
  assert.ok(m.calls.every(x => x.options.method === 'GET' && x.options.redirect === 'error'));
  assert.deepEqual(m.calls.map(x => new URL(x.url).pathname), [`/api/v1/deploys/${deployId}`, `/api/v1/sites/${siteId}`]);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});
test('invalid inputs, forged URL and prod alias cannot query provider', async () => {
  for (const patch of [
    { token:'' }, { commit:'abc' }, { branch:'master' }, { alias:'verified-integrated-platform' },
    { source:{...source, production:{...source.production, branch:previewBranch }} },
    { source:{...source, production:{...source.production, deployId:'not-id'}} },
    { source:{...source, aliasDeployObserved:false} },
    { source:{...source, deploys:[{branch:previewBranch,context:'branch-deploy',state:'building'}]} },
    { cli:{...cli, deploy_id:'INVALID'} }, { cli:{...cli, deploy_url:'https://example.org/'} },
    { cli:{...cli, deploy_url:'http://'+previewAlias+'--'+siteName+'.netlify.app/'} },
    { cli:{...cli, deploy_url:'https://'+previewAlias+'--'+siteName+'.netlify.app/?token=x'} },
  ]) {
    const m = mocked();
    await assert.rejects(verifyCliPreview({ ...input, ...patch, fetchImpl:m.fetchImpl }), PreviewValidationError);
    assert.equal(m.calls.length,0);
  }
});
test('provider states, cross-site deploy and unexpected contexts fail closed', async () => {
  for (const patch of [{site_id:'other'},{state:'processing'},{context:'production'},{branch:'master'},{id:'another'}]) {
    await rejects(verifyCliPreview({...input,fetchImpl:mocked({deploy:{...deployed,...patch}}).fetchImpl}), 'DEPLOY_SCOPE_OR_STATE');
  }
});
test('production branch, published deploy, repository and project are immutable', async () => {
  for (const patch of [{published_deploy:{id:'changed'}},
    {build_settings:{...site.build_settings,repo_branch:previewBranch}},
    {build_settings:{...site.build_settings,repo_path:'different/repo'}},
    {id:'unknown-site'},{name:'other'}]) {
    await rejects(verifyCliPreview({...input,fetchImpl:mocked({project:{...site,...patch}}).fetchImpl}), 'PRODUCTION_IDENTITY_CHANGED');
  }
});
test('non-JSON and denied read never surface provider response body or secrets', async () => {
  const http = async () => ({ok:false,status:403,json:async()=>{throw Error('secret in body')}});
  await rejects(verifyCliPreview({...input,fetchImpl:http}), 'PROVIDER_HTTP');
  const json = async () => ({ok:true,json:async()=>{throw Error('secret in malformed body')}});
  await rejects(verifyCliPreview({...input,fetchImpl:json}), 'PROVIDER_INVALID_JSON');
  const thrown = async () => { throw Error('secret full provider stack'); };
  await rejects(verifyCliPreview({...input,fetchImpl:thrown}), 'PROVIDER_UNAVAILABLE');
});
