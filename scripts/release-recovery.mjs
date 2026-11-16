import path from 'node:path';
import { pathToFileURL } from 'node:url';

const refs = new Set(['refs/heads/master', 'refs/heads/Integrated-Marketing-Platform',
  'refs/heads/feature/productization-super-admin']);
const required = ['recovery_member', 'recovery_netlify', 'recovery_ticket'];

export function requireRecoveryBaselines({ event, ref, sha, needs }) {
  if (event !== 'workflow_dispatch' || !refs.has(ref) || !/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error('RECOVERY_SOURCE_NOT_ALLOWED');
  }
  if (!needs || required.some(key => needs[key]?.result !== 'success')) {
    throw new Error('RECOVERY_BASELINES_NOT_SUCCESSFUL');
  }
  return { status: 'verified', sha, ref, baselines: required };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = requireRecoveryBaselines({ event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
    needs: JSON.parse(process.env.RECOVERY_NEEDS || '{}') });
  console.log(JSON.stringify(result));
}
