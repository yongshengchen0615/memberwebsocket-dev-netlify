import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const previewBranch = 'Integrated-Marketing-Platform';
export const previewSite = '23796c62-480a-4b46-ac90-bfbc5ad4d300';
const repository = 'yongshengchen0615/memberwebsocket-dev-netlify';
const siteName = 'memberwebsocket-dev-netlify';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function blockNativePreview(env) {
  return env.NETLIFY === 'true' && env.BRANCH?.toLowerCase() === previewBranch.toLowerCase()
    && env.CONTEXT !== 'deploy-preview';
}

// ZIP uploads use a real, case-preserved branch, never the conflicting CLI alias.
// Refuse all other sites/branches and recheck the production identity before POST.
export async function publishPreviewBranch({ token, siteId, branch, commit, zip,
  fetchImpl = fetch, delay = pause, attempts = 60 }) {
  if (!token || siteId !== previewSite || branch !== previewBranch || !/^[a-f0-9]{40}$/.test(commit || '')
    || !Buffer.isBuffer(zip) || !zip.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
    || !Number.isInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Invalid verified preview publish input');
  async function request(resource, options = {}) {
    const response = await fetchImpl(`https://api.netlify.com/api/v1${resource}`, {
      method: 'GET', ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
      redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Preview provider HTTP ${response.status}`);
    return response.json();
  }
  const site = await request(`/sites/${siteId}`);
  if (site.id !== siteId || site.name !== siteName || site.build_settings?.repo_path !== repository
    || typeof site.build_settings.repo_branch !== 'string'
    || site.build_settings.repo_branch.toLowerCase() === branch.toLowerCase()) throw new Error('Preview source or production branch identity changed');
  const existing = await request(`/sites/${siteId}/deploys?per_page=100`);
  if (!Array.isArray(existing) || existing.some(item => item.branch?.toLowerCase() === branch.toLowerCase()
    && item.context === 'branch-deploy' && !['ready', 'error', 'rejected', 'canceled'].includes(item.state))) {
    throw new Error('A competing preview deployment is still active');
  }
  const query = new URLSearchParams({ branch, title: `verified-platform-${commit}` });
  // A POST is never retried: a timeout may have created a deploy already.
  const build = await request(`/sites/${siteId}/builds?${query}`, { method: 'POST',
    headers: { 'Content-Type': 'application/zip' }, body: zip });
  if (!/^[a-f0-9]{24}$/.test(build.deploy_id || '')) throw new Error('Preview upload did not return a deploy identity');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const deploy = await request(`/deploys/${build.deploy_id}`);
    if (deploy.id !== build.deploy_id || deploy.site_id !== siteId || deploy.branch !== branch
      || deploy.context !== 'branch-deploy') throw new Error('Published deploy does not belong to the verified preview branch');
    if (['error', 'rejected', 'canceled'].includes(deploy.state)) throw new Error('Preview deploy failed');
    if (deploy.state === 'ready') {
      const after = await request(`/sites/${siteId}`);
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
    try {
      const result = await publishPreviewBranch({ token: process.env.NETLIFY_AUTH_TOKEN,
        siteId: process.env.NETLIFY_SITE_ID, branch: process.env.GITHUB_REF_NAME,
        commit: process.env.COMMIT_REF, zip: await readFile('evidence/platform-preview.zip') });
      await mkdir('evidence', { recursive: true });
      await writeFile('evidence/platform-deploy.json', JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    } catch {
      console.error('Verified preview publication failed; inspect deployment state before retrying. Provider bodies and credentials were not logged.');
      process.exitCode = 1;
    }
  } else throw new Error('Expected --ignore, --build or --publish');
}
