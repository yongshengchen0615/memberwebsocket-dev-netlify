import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../MemberWebsocket-dev/supabase/retirement/retired-endpoints.json', import.meta.url), 'utf8'));
const methods = ['GET', 'OPTIONS', 'POST'];

export async function verifyRetiredEndpoints(origin, send) {
  const { retiredFunctions, expectedStatus, expectedErrorCode } = manifest;
  assert.equal(new Set(retiredFunctions).size, 5, 'Expected five retired functions');
  assert.equal(retiredFunctions.length, 5);
  for (const name of retiredFunctions) {
    assert.match(name, /^[a-z][a-z0-9-]*$/);
    for (const method of methods) {
      const request = new Request(new URL('/functions/v1/' + name, origin), {
        method,
        headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{not valid JSON' } : {}),
        redirect: 'error',
      });
      const response = await send(request);
      assert.equal(response.status, expectedStatus, `${name} ${method} must fail closed`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const payload = await response.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error?.code, expectedErrorCode);
    }
  }
  return retiredFunctions.length * methods.length;
}

export function productionRetirementOrigin(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/master' ||
      env.GITHUB_WORKFLOW !== 'Publish verified master to Netlify' ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Production retirement probe requires the master release workflow');
  }
  const config = JSON.parse(readFileSync(new URL('../MemberWebsocket-dev/config/production/config.json', import.meta.url), 'utf8'));
  const expectedOrigin = `https://${manifest.projectId}.supabase.co`;
  assert.equal(config.supabaseUrl, expectedOrigin, 'Retirement manifest and production configuration target different projects');
  return expectedOrigin;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assert.deepEqual(process.argv.slice(2), ['--production']);
  const origin = productionRetirementOrigin(process.env);
  const checked = await verifyRetiredEndpoints(origin, request => fetch(request, { signal: AbortSignal.timeout(15000) }));
  console.log(`Verified ${checked} retired endpoint responses in the production release.`);
}
