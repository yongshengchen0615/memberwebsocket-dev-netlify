import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const previewBranch = 'Integrated-Marketing-Platform';
export const previewSite = '23796c62-480a-4b46-ac90-bfbc5ad4d300';
const repository = 'yongshengchen0615/memberwebsocket-dev-netlify';
const siteName = 'memberwebsocket-dev-netlify';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const publishPhases = new Set(['input', 'site', 'site-identity', 'deploy-list', 'deploy-list-validation', 'upload', 'upload-response', 'deploy-status', 'deploy-identity', 'production', 'production-identity']);

export class PreviewProviderError extends Error {
  constructor(phase, status) {
    super(`Preview provider HTTP ${Number.isInteger(status) && status >= 400 && status <= 599 ? status : 'unknown'}`);
    this.name = 'PreviewProviderError';
    this.phase = phase;
    this.status = status;
  }
}

// Logs only a local phase label and numeric HTTP status, never provider response data.
export function describePreviewPublishFailure(error, lastPhase = 'unclassified') {
  if (error instanceof PreviewProviderError) {
    const phase = publishPhases.has(error.phase) ? error.phase : 'unclassified';
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status : 'unknown';
    return `Verified preview publication failed during ${phase}: HTTP ${status}. Inspect deployment state before retrying. Provider bodies and credentials were not logged.`;
  }
  const phase = publishPhases.has(lastPhase) ? lastPhase : 'unclassified';
  return `Verified preview publication failed during ${phase} (unclassified). Inspect deployment state before retrying. Provider bodies and credentials were not logged.`;
}

export function blockNativePreview(env) {
  return env.NETLIFY === 'true' && env.BRANCH?.toLowerCase() === previewBranch.toLowerCase()
    && env.CONTEXT !== 'deploy-preview';
}

// ZIP uploads use a real, case-preserved branch, never the conflicting CLI alias.
// Refuse all other sites/branches and recheck the production identity before POST.
export async function publishPreviewBranch({ token, siteId, branch, commit, zip,
  fetchImpl = fetch, delay = pause, attempts = 60, onPhase = () => {} }) {
  onPhase('input');
  if (!token || siteId !== previewSite || branch !== previewBranch || !/^[a-f0-9]{40}$/.test(commit || '')
    || !Buffer.isBuffer(zip) || !zip.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
    || !Number.isInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Invalid verified preview publish input');
  async function request(resource, options = {}, phase = 'unclassified') {
    const response = await fetchImpl(`https://api.netlify.com/api/v1${resource}`, {
      method: 'GET', ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
      redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new PreviewProviderError(phase, response.status);
    return response.json();
  }
  onPhase('site');
  const site = await request(`/sites/${siteId}`, {}, 'site');
  onPhase('site-identity');
  if (site.id !== siteId || site.name !== siteName || site.build_settings?.repo_path !== repository
    || typeof site.build_settings.repo_branch !== 'string'
    || site.build_settings.repo_branch.toLowerCase() === branch.toLowerCase()) throw new Error('Preview source or production branch identity changed');
  onPhase('deploy-list');
  const existing = await request(`/sites/${siteId}/deploys?per_page=100`, {}, 'deploy-list');
  onPhase('deploy-list-validation');
  if (!Array.isArray(existing) || existing.some(item => item.branch?.toLowerCase() === branch.toLowerCase()
    && item.context === 'branch-deploy' && !['ready', 'error', 'rejected', 'canceled'].includes(item.state))) {
    throw new Error('A competing preview deployment is still active');
  }
  const query = new URLSearchParams({ branch, title: `verified-platform-${commit}` });
  // A POST is never retried: a timeout may have created a deploy already.
  onPhase('upload');
  const build = await request(`/sites/${siteId}/builds?${query}`, { method: 'POST',
    headers: { 'Content-Type': 'application/zip' }, body: zip }, 'upload');
  onPhase('upload-response');
  if (!/^[a-f0-9]{24}$/.test(build.deploy_id || '')) throw new Error('Preview upload did not return a deploy identity');
  for (let attempt = 0; attempt < attempts; attempt++) {
    onPhase('deploy-status');
    const deploy = await request(`/deploys/${build.deploy_id}`, {}, 'deploy-status');
    onPhase('deploy-identity');
    if (deploy.id !== build.deploy_id || deploy.site_id !== siteId || deploy.branch !== branch
      || deploy.context !== 'branch-deploy') throw new Error('Published deploy does not belong to the verified preview branch');
    if (['error', 'rejected', 'canceled'].includes(deploy.state)) throw new Error('Preview deploy failed');
    if (deploy.state === 'ready') {
      onPhase('production');
      const after = await request(`/sites/${siteId}`, {}, 'production');
      onPhase('production-identity');
      if (after.published_deploy?.id !== site.published_deploy?.id
        || after.build_settings?.repo_branch !== site.build_settings.repo_branch) throw new Error('Production identity changed during preview publication');
      return { deploy_id: deploy.id, deploy_url: `https://${deploy.id}--${siteName}.netlify.app`,
        source_sha: commit, source_branch: branch, context: deploy.context,
        production_deploy_unchanged: true };
    }
    if (attempt + 1 < attempts) await delay(3000);
  }
  throw new Error('Preview deploy did not become ready before the deadline');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === '--ignore') process.exitCode = blockNativePreview(process.env) ? 0 : 1;
  else if (mode === '--build') {
    // A build hook can bypass Netlify's ignore command; block it here as well.
    if (blockNativePreview(process.env)) throw new Error('This preview branch is published only by verified GitHub Actions');
    await import('./build-site.mjs');
  } else if (mode === '--publish') {
    let lastPhase = 'input';
    try {
      const result = await publishPreviewBranch({ token: process.env.NETLIFY_AUTH_TOKEN,
        siteId: process.env.NETLIFY_SITE_ID, branch: process.env.GITHUB_REF_NAME,
        commit: process.env.COMMIT_REF, zip: await readFile('evidence/platform-preview.zip'),
        onPhase: phase => { if (publishPhases.has(phase)) lastPhase = phase; } });
      await mkdir('evidence', { recursive: true });
      await writeFile('evidence/platform-deploy.json', JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(describePreviewPublishFailure(error, lastPhase));
      process.exitCode = 1;
    }
  } else throw new Error('Expected --ignore, --build or --publish');
}
