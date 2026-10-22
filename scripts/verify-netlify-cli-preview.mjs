import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const siteId = '23796c62-480a-4b46-ac90-bfbc5ad4d300';
export const siteName = 'memberwebsocket-dev-netlify';
export const previewBranch = 'Integrated-Marketing-Platform';
export const previewAlias = 'verified-integrated-platform';
const repo = 'yongshengchen0615/memberwebsocket-dev-netlify';
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export class PreviewValidationError extends Error {
  constructor(code) { super(code); this.name = 'PreviewValidationError'; this.code = code; }
}
const fail = code => { throw new PreviewValidationError(code); };

// Validate the CLI's one-shot, non-production draft *after* it has uploaded.
// The stable draft alias is intentionally different from the native Git branch.
export async function verifyCliPreview({ cli, source, token, commit, branch, alias, fetchImpl = fetch }) {
  if (!token || !sha(commit) || branch !== previewBranch || alias !== previewAlias) fail('INVALID_RELEASE_INPUT');
  if (!source || source.siteId !== siteId || source.branch !== previewBranch
    || source.production?.branch !== 'master' || !id(source.production?.deployId)
    || source.build?.repository !== repo) fail('SOURCE_IDENTITY');
  if (!cli || !id(cli.deploy_id)) fail('INVALID_DEPLOY_ID');
  let url;
  try { url = new URL(cli.deploy_url); } catch { fail('INVALID_DEPLOY_URL'); }
  const host = `${previewAlias}--${siteName}.netlify.app`;
  if (url.protocol !== 'https:' || (url.hostname !== host && url.hostname !== `${cli.deploy_id}--${siteName}.netlify.app`)
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) fail('DEPLOY_URL_SCOPE');
  async function request(endpoint) {
    let response;
    try {
      response = await fetchImpl(`https://api.netlify.com/api/v1${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }, method: 'GET',
        redirect: 'error', signal: AbortSignal.timeout(20000),
      });
    } catch { fail('PROVIDER_UNAVAILABLE'); }
    if (!response.ok) fail('PROVIDER_HTTP');
    try { return await response.json(); } catch { fail('PROVIDER_INVALID_JSON'); }
  }
  const deployment = await request(`/deploys/${cli.deploy_id}`);
  if (deployment.id !== cli.deploy_id || deployment.site_id !== siteId ||
      deployment.state !== 'ready' || deployment.context === 'production' ||
      (deployment.branch != null && deployment.branch !== previewAlias)) fail('DEPLOY_SCOPE_OR_STATE');
  const site = await request(`/sites/${siteId}`);
  if (site.id !== siteId || site.name !== siteName ||
      site.published_deploy?.id !== source.production.deployId ||
      site.build_settings?.repo_branch !== source.production.branch ||
      site.build_settings?.repo_path !== repo) fail('PRODUCTION_IDENTITY_CHANGED');
  return {
    deploy_id: cli.deploy_id,
    deploy_url: `https://${host}`,
    immutable_url: `https://${cli.deploy_id}--${siteName}.netlify.app`,
    source_sha: commit,
    source_branch: branch,
    alias: previewAlias,
    site_id: siteId,
    context: deployment.context ?? null,
    production_deploy_unchanged: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [cli, source] = await Promise.all([
      readFile(process.argv[2], 'utf8').then(JSON.parse),
      readFile('evidence/platform-source.json', 'utf8').then(JSON.parse),
    ]);
    const verified = await verifyCliPreview({
      cli, source, token: process.env.NETLIFY_AUTH_TOKEN,
      commit: process.env.COMMIT_REF, branch: process.env.GITHUB_REF_NAME, alias: process.env.PLATFORM_ALIAS,
    });
    await mkdir('evidence', { recursive: true });
    await writeFile('evidence/platform-deploy.json', JSON.stringify(verified, null, 2) + '\n');
    console.log(JSON.stringify(verified));
  } catch (error) {
    // All emitted messages are local, allowlisted codes only; never provider data or tokens.
    const code = error instanceof PreviewValidationError ? error.code : 'UNCLASSIFIED';
    console.error(`Verified CLI preview validation failed: ${code}`);
    process.exitCode = 1;
  }
}
