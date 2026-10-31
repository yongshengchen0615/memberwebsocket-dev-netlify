import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const siteId = '196e1d2c-8216-4ba8-aeb9-1706660adc2b';
const repo = 'yongshengchen0615/memberwebsocket-dev-netlify';
const branch = 'Integrated-Marketing-Platform';
const siteName = 'memberwebsocket-dev-netlify';
const pause = ms => new Promise(r => setTimeout(r, ms));
export class NativeDeployError extends Error {
  constructor(code) { super(code); this.name = 'NativeDeployError'; this.code = code; }
}
const fail = code => { throw new NativeDeployError(code); };
export async function verifyNativePreview({ commit, token, source, fetchImpl = fetch,
  delay = pause, attempts = 60, delayMs = 4000 }) {
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !token ||
    !Number.isInteger(attempts) || attempts < 1 || attempts > 120 ||
    !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) fail('INVALID_INPUT');
  if (source?.siteId !== siteId || source.branch !== branch ||
    source.production?.branch !== 'master' || !/^[a-f0-9]{24}$/.test(source.production?.deployId || '') ||
    source.build?.repository !== repo) fail('INVALID_SOURCE');
  async function request(resource) {
    let response;
    try {
      response = await fetchImpl('https://api.netlify.com/api/v1' + resource, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { fail('PROVIDER_UNAVAILABLE'); }
    if (!response.ok) fail('PROVIDER_HTTP_' + (response.status >= 400 && response.status <= 599 ? response.status : 'unknown'));
    try { return await response.json(); } catch { fail('PROVIDER_JSON_INVALID'); }
  }
  const expected = 'https://' + branch.toLowerCase() + '--' + siteName + '.netlify.app';
  for (let n = 0; n < attempts; n++) {
    const items = await request(`/sites/${siteId}/deploys?per_page=100`);
    if (!Array.isArray(items)) fail('DEPLOY_LIST_INVALID');
    const matching = items.filter(x => x.branch === branch && x.context === 'branch-deploy'
      && x.commit_ref === commit && x.site_id === siteId);
    const valid = matching.find(x => x.state === 'ready' && /^[a-f0-9]{24}$/.test(x.id || ''));
    if (valid) {
      const detail = await request(`/deploys/${valid.id}`);
      if (detail.id !== valid.id || detail.site_id !== siteId || detail.context !== 'branch-deploy'
        || detail.branch !== branch || detail.commit_ref !== commit || detail.state !== 'ready'
        || detail.deploy_ssl_url !== expected) fail('DEPLOY_IDENTITY_MISMATCH');
      const site = await request(`/sites/${siteId}`);
      if (site.id !== siteId || site.name !== siteName ||
        site.published_deploy?.id !== source.production.deployId ||
        site.build_settings?.repo_branch !== 'master' ||
        site.build_settings?.repo_path !== repo) fail('PRODUCTION_IDENTITY_CHANGED');
      return { deploy_id: valid.id, deploy_url: expected,
        immutable_url: `https://${valid.id}--${siteName}.netlify.app`,
        source_branch: branch, source_sha: commit, context: 'branch-deploy',
        production_deploy_unchanged: true };
    }
    if (matching.some(x => ['error', 'rejected', 'canceled'].includes(x.state))) fail('NATIVE_DEPLOY_FAILED');
    if (n + 1 < attempts) await delay(delayMs);
  }
  fail('DEPLOY_NOT_READY');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const source = JSON.parse(await readFile('evidence/platform-source.json', 'utf8'));
    const result = await verifyNativePreview({ source,
      commit: process.env.COMMIT_REF, token: process.env.NETLIFY_AUTH_TOKEN });
    await mkdir('evidence', { recursive: true });
    await writeFile('evidence/platform-deploy.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = error instanceof NativeDeployError ? error.code : 'UNCLASSIFIED';
    console.error('Verified native branch preview failed: ' + code);
    process.exitCode = 1;
  }
}
