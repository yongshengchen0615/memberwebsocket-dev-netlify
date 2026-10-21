import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const required = ['test-memberwebsocket-dev.yml', 'test-netlify-build.yml', 'test-memberwebsocket-ticket-policy.yml'];

export function evaluatePreviewCI(runs, sha) {
  const workflows = required.map(file => {
    const latest = runs.filter(run => run.head_sha === sha && run.path?.split('/').at(-1) === file)
      .sort((a, b) => Number(b.id) - Number(a.id) || Number(b.run_attempt || 1) - Number(a.run_attempt || 1))[0];
    return { file, runId: latest?.id ?? null, status: latest?.status ?? 'missing', conclusion: latest?.conclusion ?? null };
  });
  const status = workflows.some(run => run.status === 'completed' && run.conclusion !== 'success') ? 'failure'
    : workflows.every(run => run.status === 'completed' && run.conclusion === 'success') ? 'success' : 'pending';
  return { sha, status, workflows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const sha = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !Array.isArray(input.workflow_runs)) throw new Error('Expected exact commit SHA and workflow run list');
  const result = evaluatePreviewCI(input.workflow_runs, sha);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'success' ? 0 : result.status === 'pending' ? 2 : 1;
}
