import { isNativeVerifiedPreview, awaitVerifiedPreviewCI } from './netlify-native-ci-gate.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const previewBranch = 'Integrated-Marketing-Platform';
export const previewSite = '196e1d2c-8216-4ba8-aeb9-1706660adc2b';
const repository = 'yongshengchen0615/memberwebsocket-dev-netlify';
const siteName = 'memberwebsocket-dev-netlify';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const publishPhases = new Set(['site', 'deploy-list', 'upload', 'deploy-status', 'production']);

export class PreviewProviderError extends Error {
  constructor(phase, status) {
    super(`Preview provider HTTP ${Number.isInteger(status) && status >= 400 && status <= 599 ? status : 'unknown'}`);
    this.name = 'PreviewProviderError';
    this.phase = phase;
    this.status = status;
  }
}

// Logs only a local phase label and numeric HTTP status, never provider response data.
export function describePreviewPublishFailure(error) {
  if (error instanceof PreviewProviderError) {
    const phase = publishPhases.has(error.phase) ? error.phase : 'unclassified';
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status : 'unknown';
    return `Verified preview publication failed during ${phase}: HTTP ${status}. Inspect deployment state before retrying. Provider bodies and credentials were not logged.`;
  }
  // Exact internal error strings are safe; provider-supplied errors are never logged.
  const safeErrors = new Map([
    ['Invalid verified preview publish input', 'INVALID_INPUT'],
    ['Preview source or production branch identity changed', 'SOURCE_IDENTITY'],
    ['A competing preview deployment is still active', 'ACTIVE_DEPLOY'],
    ['Preview upload did not return a deploy identity', 'INVALID_DEPLOY_ID'],
    ['Published deploy does not belong to the verified preview branch', 'WRONG_DEPLOY_SCOPE'],
    ['Preview deploy failed', 'DEPLOY_FAILED'],
    ['Production identity changed during preview publication', 'PRODUCTION_CHANGED'],
    ['Preview deploy did not become ready before the deadline', 'DEPLOY_NOT_READY'],
  ]);
  const safeCode = error instanceof Error ? safeErrors.get(error.message) : null;
  if (safeCode) return `Verified preview publication blocked: ${safeCode}. Inspect site and deploy identity before retrying.`;
  return 'Verified preview publication failed (unclassified). Inspect deployment state before retrying. Provider bodies and credentials were not logged.';
}

export function blockNativePreview(env) {
  return env.NETLIFY === 'true' && env.BRANCH?.toLowerCase() === previewBranch.toLowerCase()
    && (env.BRANCH !== previewBranch || !['branch-deploy', 'deploy-preview'].includes(env.CONTEXT));
}

// ZIP uploads use a real, case-preserved branch, never the conflicting CLI alias.
// Refuse all other sites/branches and recheck the production identity before POST.
export async function publishPreviewBranch({ token, siteId, branch, commit, zip,
  fetchImpl = fetch, delay = pause, attempts = 60 }) {
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
  const site = await request(`/sites/${siteId}`, {}, 'site');
  if (site.id !== siteId || site.name !== siteName || site.build_settings?.repo_path !== repository
    || typeof site.build_settings.repo_branch !== 'string'
    || site.build_settings.repo_branch.toLowerCase() === branch.toLowerCase()) throw new Error('Preview source or production branch identity changed');
  const existing = await request(`/sites/${siteId}/deploys?per_page=100`, {}, 'deploy-list');
  if (!Array.isArray(existing) || existing.some(item => item.branch?.toLowerCase() === branch.toLowerCase()
    && item.context === 'branch-deploy' && !['ready', 'error', 'rejected', 'canceled'].includes(item.state))) {
    throw new Error('A competing preview deployment is still active');
  }
  const query = new URLSearchParams({ branch, title: `verified-platform-${commit}` });
  // A POST is never retried: a timeout may have created a deploy already.
  // An API "build" invokes the site's branch build/ignore hook and can be
  // cancelled even when CI has already produced a verified ZIP. Submit the
  // exact artifact as a branch-scoped ZIP *deploy* instead; no provider rebuild.
  const upload = await request(`/sites/${siteId}/deploys?${query}`, { method: 'POST',
    headers: { 'Content-Type': 'application/zip' }, body: zip }, 'upload');
  if (!/^[a-f0-9]{24}$/.test(upload.id || '')) throw new Error('Preview upload did not return a deploy identity');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const deploy = await request(`/deploys/${upload.id}`, {}, 'deploy-status');
    if (deploy.id !== upload.id || deploy.site_id !== siteId || deploy.branch !== branch
      || deploy.context !== 'branch-deploy') throw new Error('Published deploy does not belong to the verified preview branch');
    if (['error', 'rejected', 'canceled'].includes(deploy.state)) throw new Error('Preview deploy failed');
    if (deploy.state === 'ready') {
      const after = await request(`/sites/${siteId}`, {}, 'production');
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
    if (blockNativePreview(process.env)) throw new Error('This preview branch has an invalid branch or context identity');
    if (isNativeVerifiedPreview(process.env)) {
      const verified = await awaitVerifiedPreviewCI({
        sha: process.env.COMMIT_REF, token: process.env.NETLIFY_GITHUB_READ_TOKEN || '',
      });
      console.log(JSON.stringify({ nativePreviewVerified: true, sha: verified.sha, ciRuns: verified.runIds }));
      // Rebuild verification uses this same Git timestamp and native deploy ID.
      process.env.VERIFIED_PREVIEW_SOURCE_EPOCH = execFileSync('git',
        ['show', '-s', '--format=%ct', verified.sha], { encoding: 'utf8' }).trim();
    }
    await import('./build-site.mjs');
  } else if (mode === '--publish') {
    try {
      const result = await publishPreviewBranch({ token: process.env.NETLIFY_AUTH_TOKEN,
        siteId: process.env.NETLIFY_SITE_ID, branch: process.env.GITHUB_REF_NAME,
        commit: process.env.COMMIT_REF, zip: await readFile('evidence/platform-preview.zip') });
      await mkdir('evidence', { recursive: true });
      await writeFile('evidence/platform-deploy.json', JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(describePreviewPublishFailure(error));
      process.exitCode = 1;
    }
  } else throw new Error('Expected --ignore, --build or --publish');
}
