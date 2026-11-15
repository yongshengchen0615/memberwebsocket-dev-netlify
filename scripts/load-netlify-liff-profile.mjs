import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { previewMemberRuntime } from './preview-member-runtime.mjs';

// GitHub Actions uploads must use the same Netlify site-scoped LIFF settings
// as native Netlify branch builds. Do not log profile contents.
const targets = Object.freeze({
  master: { key: 'PUBLIC_LIFF_CONFIG_PRODUCTION', context: 'production' },
  'Integrated-Marketing-Platform': {
    key: 'PUBLIC_LIFF_CONFIG_TEST', context: 'branch:Integrated-Marketing-Platform',
  },
});
const liffKeys = [
  'memberLiffId', 'pointsLiffId', 'adminLiffId', 'platformLiffId',
  'eventLiffId', 'calendarLiffId', 'bookingLiffId',
];

export function validateNetlifyLiffProfile(output, branch) {
  if (!Object.hasOwn(targets, branch)) throw new Error('Unsupported deployment branch');
  const raw = output.trim();
  if (!raw || raw === 'undefined' || raw === 'null') return null; // profile not configured
  const key = targets[branch].key;
  // Use the same fail-closed parser as the actual site build.
  const parsed = JSON.parse(raw);
  const checked = previewMemberRuntime(
    { supabaseUrl: 'https://example.supabase.co' },
    { BRANCH: branch, CONTEXT: branch === 'master' ? 'production' : 'branch-deploy', [key]: raw },
  );
  for (const field of liffKeys) if (checked[field] !== parsed[field]) {
    throw new Error('Netlify LIFF profile failed runtime verification');
  }
  return JSON.stringify(parsed);
}

export function loadNetlifyLiffProfile(branch, env, spawn = spawnSync) {
  if (!Object.hasOwn(targets, branch)) return { status: 'not-applicable' };
  if (!env.NETLIFY_SITE_ID || !env.NETLIFY_AUTH_TOKEN || !env.GITHUB_ENV) {
    throw new Error('Missing Netlify release credentials or GitHub environment output');
  }
  const { key, context } = targets[branch];
  const result = spawn('npx', ['--yes', 'netlify-cli@23.11.0', 'env:get', key,
    '--context', context, '--scope', 'builds', '--site', env.NETLIFY_SITE_ID], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 256000, env,
  });
  if (result.error) throw new Error('Unable to query Netlify LIFF build variable');
  if (result.status !== 0) {
    // Only a genuinely absent variable may use the known-good pinned defaults.
    // Network/authorization errors must not silently cause config drift.
    if (!/(?:not found|not set|does not exist|no value)/i.test(result.stderr || '')) {
      throw new Error('Unable to read Netlify LIFF build variable (not a missing-value response)');
    }
    return { status: 'pinned-default', key };
  }
  const profile = validateNetlifyLiffProfile(result.stdout || '', branch);
  if (!profile) return { status: 'pinned-default', key };
  appendFileSync(env.GITHUB_ENV, `${key}=${profile}\n`);
  return { status: 'site-profile', key };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const branch = process.argv[2] || process.env.GITHUB_REF_NAME;
  const result = loadNetlifyLiffProfile(branch, process.env);
  console.log(`Public LIFF release source: ${result.status}`);
}
