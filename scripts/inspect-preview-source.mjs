import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const branchName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ? value : null;
const identifier = value => typeof value === 'string' && /^[a-f0-9-]{20,40}$/.test(value) ? value : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
const oneOf = (value, values) => values.includes(value) ? value : null;

// Never serialize raw provider objects: build_settings and deploys may contain
// environment variables, private URLs, titles, or unexpected provider fields.
export function summarizePreviewSource(site, deploys, { siteId, branch, alias }) {
  if (site?.id !== siteId) throw new Error('Netlify site identity does not match');
  if (!Array.isArray(deploys)) throw new Error('Invalid Netlify deploy list');
  if (!branchName(branch) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(alias || '')) throw new Error('Invalid preview routing input');
  const build = site.build_settings || {};
  const relevant = deploys.filter(item => [branch, alias].includes(item.branch)).slice(0, 20).map(item => ({
    id: identifier(item.id), branch: branchName(item.branch),
    context: oneOf(item.context, ['production', 'branch-deploy', 'deploy-preview', 'dev']),
    state: oneOf(item.state, ['ready', 'error', 'building', 'enqueued', 'new', 'uploaded', 'uploading', 'prepared', 'processing', 'retrying', 'rejected', 'canceled']),
    commit: sha(item.commit_ref), hasBuild: Boolean(identifier(item.build_id)),
  }));
  return {
    siteId, branch, alias,
    aliasMatchesGitBranch: branch.toLowerCase().replace(/[^a-z0-9-]/g, '-') === alias,
    production: { branch: branchName(build.repo_branch), deployId: identifier(site.published_deploy?.id), commit: sha(site.published_deploy?.commit_ref) },
    build: {
      provider: oneOf(build.provider, ['github', 'gitlab', 'bitbucket', 'azure_devops']),
      repository: typeof build.repo_path === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(build.repo_path) ? build.repo_path : null,
      staticCommand: build.cmd === 'node scripts/build-site.mjs',
      publishIsDist: build.dir === 'dist',
      ignoreCommandConfigured: Boolean(build.ignore),
      allowedBranches: Array.isArray(build.allowed_branches) ? build.allowed_branches.map(branchName).filter(Boolean) : null,
      stopBuilds: typeof build.stop_builds === 'boolean' ? build.stop_builds : null,
      skipPullRequests: typeof build.skip_prs === 'boolean' ? build.skip_prs : null,
    },
    nativeBranchDeployObserved: relevant.some(item => item.branch === branch && item.context === 'branch-deploy'),
    aliasDeployObserved: relevant.some(item => item.branch === alias && !item.hasBuild && !item.commit),
    deploys: relevant,
  };
}

export async function inspectPreviewSource({ token, siteId, branch, alias, fetchImpl = fetch }) {
  if (!token) throw new Error('Netlify read credential is required');
  if (!/^[a-f0-9-]{36}$/.test(siteId || '')) throw new Error('Invalid Netlify site identity');
  async function get(resource) {
    const response = await fetchImpl(`https://api.netlify.com/api/v1/sites/${siteId}${resource}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Netlify source inspection HTTP ${response.status}`);
    return response.json();
  }
  const site = await get('');
  const deploys = await get('/deploys?per_page=100');
  return summarizePreviewSource(site, deploys, { siteId, branch, alias });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await inspectPreviewSource({ token: process.env.NETLIFY_AUTH_TOKEN, siteId: process.env.NETLIFY_SITE_ID,
      branch: process.env.PREVIEW_SOURCE_BRANCH, alias: process.env.PLATFORM_ALIAS });
    await mkdir('evidence', { recursive: true });
    await writeFile('evidence/platform-source.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch {
    // Network/JSON errors can embed provider data. Emit a fixed message only.
    console.error('Preview source inspection failed; no provider response or credential was logged.');
    process.exitCode = 1;
  }
}
