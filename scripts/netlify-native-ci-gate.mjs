import { evaluatePreviewCI } from './check-preview-ci.mjs';

const repository = 'yongshengchen0615/memberwebsocket-dev-netlify';
export const verifiedBranch = 'Integrated-Marketing-Platform';
export function isNativeVerifiedPreview(env) {
  return env.NETLIFY === 'true' && env.BRANCH === verifiedBranch && env.CONTEXT === 'branch-deploy';
}
export class NativeCiGateError extends Error {
  constructor(code) { super(code); this.name = 'NativeCiGateError'; this.code = code; }
}
const fail = code => { throw new NativeCiGateError(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function awaitVerifiedPreviewCI({ sha, branch = verifiedBranch, fetchImpl = fetch, delay = pause,
  attempts = 30, delayMs = 30000, token = '' }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || branch !== verifiedBranch ||
    !Number.isInteger(attempts) || attempts < 1 || attempts > 40 ||
    !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) fail('INVALID_SOURCE');
  const url = new URL(`https://api.github.com/repos/${repository}/actions/runs`);
  url.search = new URLSearchParams({ branch, event: 'push', head_sha: sha, per_page: '100' }).toString();
  for (let n = 0; n < attempts; n++) {
    let response, data;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'verified-netlify-native-preview',
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch { fail('CI_FETCH_UNAVAILABLE'); }
    if (response.status !== 200) fail('CI_PROVIDER_HTTP_' + (response.status >= 400 && response.status <= 599 ? response.status : 'unknown'));
    try { data = await response.json(); } catch { fail('CI_INVALID_RESPONSE'); }
    if (!Array.isArray(data?.workflow_runs)) fail('CI_INVALID_RESPONSE');
    const result = evaluatePreviewCI(data.workflow_runs, sha, branch);
    if (result.status === 'success') return { sha, branch, runIds: result.workflows.map(x => x.runId), status: result.status };
    if (result.status === 'failure') fail('CI_REQUIRED_CHECK_FAILED');
    if (n + 1 < attempts) await delay(delayMs);
  }
  fail('CI_NOT_COMPLETE');
}

if (process.argv[1]?.endsWith('/netlify-native-ci-gate.mjs')) {
  if (!isNativeVerifiedPreview(process.env)) fail('NOT_VERIFIED_BRANCH_BUILD');
  const result = await awaitVerifiedPreviewCI({ sha: process.env.COMMIT_REF, token: process.env.NETLIFY_GITHUB_READ_TOKEN || '' });
  console.log(JSON.stringify(result));
}
