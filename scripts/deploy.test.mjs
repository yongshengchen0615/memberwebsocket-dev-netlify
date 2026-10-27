import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildDate, formatBuildVersion } from './build-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: root });
const output = path.join(root, 'dist');

test('all seven application entry pages are published', () => {
  for (const surface of ['', 'admin', 'member', 'points', 'event', 'calendar', 'booking']) {
    assert.ok(fs.existsSync(path.join(output, surface, 'index.html')), surface || 'home');
  }
});

test('published HTML references resolve to files inside the frontend', () => {
  let checked = 0;
  for (const name of fs.readdirSync(output, { recursive: true })) {
    if (!name.endsWith('.html')) continue;
    const file = path.join(output, name);
    const html = fs.readFileSync(file, 'utf8');
    for (const [, value] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) continue;
      const relative = decodeURIComponent(value.split(/[?#]/)[0]);
      if (!relative) continue;
      const target = path.resolve(relative.startsWith('/') ? output : path.dirname(file), relative.replace(/^\//, ''));
      assert.ok(target === output || target.startsWith(output + path.sep), `${name}: outside output ${value}`);
      assert.ok(fs.existsSync(target), `${name}: missing ${value}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `Expected real asset validation; checked ${checked}`);
});

test('platform is a sibling of admin in the build output', () => {
  for (const asset of ['index.html', 'app.js', 'platform.css']) {
    assert.ok(fs.existsSync(path.join(output, 'platform', asset)), asset);
  }
  assert.equal(fs.existsSync(path.join(output, 'admin', 'platform')), false);
  const html = fs.readFileSync(path.join(output, 'platform/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(output, 'platform/app.js'), 'utf8');
  assert.match(html, /src="\.\.\/member-system\.js"/);
  assert.match(app, /fetch\('\.\.\/config\.json'/);
});

test('server source, migrations, tests and local deployment state are not published', () => {
  for (const excluded of ['supabase', 'tests', 'docs', '.git', '.netlify', '.env']) {
    assert.equal(fs.existsSync(path.join(output, excluded)), false, excluded);
  }
  assert.equal(fs.readdirSync(output, { recursive: true }).some(name => /\.(?:sql|ts|md)$/.test(name)), false);
});

test('frontend backend settings are copied without changing identity or project', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'MemberWebsocket-dev/config.json')));
  const branch = process.env.BRANCH || process.env.PREVIEW_SOURCE_BRANCH || process.env.GITHUB_REF_NAME;
  if (branch === 'Integrated-Marketing-Platform' && process.env.CONTEXT !== 'production') {
    expected.previewApiFunctionUrl = new URL('/functions/v1/api-preview', expected.supabaseUrl).href;
    expected.memberProfileFunctionUrl = new URL('/functions/v1/member-profile-api-preview', expected.supabaseUrl).href;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'config.json'))), expected);
});


test('deployment versions are valid and change for each new deployment', () => {
  const fixed = new Date('2026-10-16T07:45:23.000Z');
  const first = formatBuildVersion(fixed, 'deploy-ABC123');
  const second = formatBuildVersion(fixed, 'deploy-XYZ789');
  assert.equal(first, 'v261016.074523-abc123');
  assert.equal(second, 'v261016.074523-xyz789');
  assert.notEqual(first, second);
  assert.notEqual(first, formatBuildVersion(new Date('2026-10-16T07:45:24.000Z'), 'deploy-ABC123'));
  assert.throws(() => formatBuildVersion(new Date('not-a-date'), 'deploy-ABC123'), TypeError);
  assert.throws(() => formatBuildVersion(fixed, 'oops'), TypeError);
});

test('all ten published entrypoints contain a static, CSP-compatible build badge', () => {
  const pages = [
    'index.html', 'admin/index.html', 'admin/workspace.html', 'member/index.html', 'points/index.html',
    'event/index.html', 'calendar/index.html', 'booking/index.html', 'booking/admin/index.html', 'platform/index.html',
  ];
  const versions = new Set();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(output, page), 'utf8');
    const match = html.match(/<small id="site-build-version" class="site-build-version" role="note" aria-label="網站部署版本 (v\d{6}\.\d{6}-[a-z0-9]{6})" data-commit="(local|[a-f\d]{7})">([^<]+)<\/small>/);
    assert.ok(match, `${page}: missing build-time badge`);
    assert.equal(match[1], match[3], `${page}: visible version must match label`);
    assert.ok(html.indexOf(match[0]) > html.indexOf('</head>'), `${page}: badge must be in body`);
    assert.equal(html.match(/id="site-build-version"/g)?.length, 1, `${page}: must render exactly once`);
    assert.doesNotMatch(html, /<script[^>]+version-badge\.js/, `${page}: must not rely on runtime JavaScript`);
    assert.doesNotMatch(match[0], /style=/, `${page}: must not use blocked inline styles`);
    const css = html.match(/<link rel="stylesheet" href="([^"]*version-badge\.css\?v=([^"]+))">/);
    assert.ok(css, `${page}: missing stylesheet`);
    assert.equal(css[2], match[1], `${page}: stylesheet cache key must equal version`);
    assert.equal(
      path.resolve(output, path.dirname(page), css[1].split('?')[0]),
      path.join(output, 'version-badge.css'),
    );
    versions.add(match[1]);
  }
  assert.equal(versions.size, 1, 'all pages in a deployment must display one version');
  assert.equal(fs.existsSync(path.join(output, 'version-badge.js')), false, 'obsolete runtime module must not ship');
});

test('badge CSS stays visible on mobile and does not obstruct touch or require inline styles', () => {
  const css = fs.readFileSync(path.join(output, 'version-badge.css'), 'utf8');
  assert.match(css, /html body > \.site-build-version\s*\{/);
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /z-index:\s*2147483000/);
  assert.match(css, /display:\s*block/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /@media print/);
});


const testModeAllowedOrigins = [
  'https://yongshengchen0615.github.io',
  'https://memberwebsocket-dev-netlify.netlify.app',
  'https://develop--memberwebsocket-dev-netlify.netlify.app',
];

test('test-mode API source preserves explicit CORS allowlist and request authorization', () => {
  const source = fs.readFileSync(path.join(root, 'MemberWebsocket-dev/supabase/functions/test-mode-api/index.ts'), 'utf8');
  for (const origin of testModeAllowedOrigins) {
    assert.ok(source.includes(JSON.stringify(origin)), 'Missing trusted origin: ' + origin);
  }
  assert.match(source, /origin && allowedOrigins\(\)\.has\(origin\)/);
  assert.match(source, /if \(request\.method === "OPTIONS"\)/);
  assert.match(source, /if \(origin && !allowedOrigins\(\)\.has\(origin\)\)/);
  assert.doesNotMatch(source, /"Access-Control-Allow-Origin":\s*"\*"/);
});

test('deployed test-mode API responds to browser preflight only for trusted origins', async () => {
  const { supabaseUrl } = JSON.parse(fs.readFileSync(path.join(root, 'MemberWebsocket-dev/config.json'), 'utf8'));
  const endpoint = new URL('/functions/v1/test-mode-api', supabaseUrl);
  const preflight = async (origin) => fetch(endpoint, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,apikey',
    },
    signal: AbortSignal.timeout(15000),
  });
  for (const origin of testModeAllowedOrigins) {
    const response = await preflight(origin);
    assert.equal(response.status, 204, origin + ': preflight must return 204');
    assert.equal(response.headers.get('access-control-allow-origin'), origin, origin);
    const allowedHeaders = (response.headers.get('access-control-allow-headers') || '')
      .toLowerCase().split(',').map(x => x.trim());
    assert.ok(allowedHeaders.includes('apikey'), origin + ': apikey blocked');
    assert.ok(allowedHeaders.includes('content-type'), origin + ': content-type blocked');
    assert.ok((response.headers.get('access-control-allow-methods') || '').includes('POST'));
    assert.match(response.headers.get('vary') || '', /\bOrigin\b/i);
  }
  const untrusted = 'https://untrusted.example';
  const deniedResponse = await preflight(untrusted);
  assert.notEqual(deniedResponse.headers.get('access-control-allow-origin'), untrusted);
});


test('deployed test-mode API returns a CORS-readable rejection for malformed POST requests', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'MemberWebsocket-dev/config.json'), 'utf8'));
  const origin = 'https://develop--memberwebsocket-dev-netlify.netlify.app';
  const response = await fetch(new URL('/functions/v1/test-mode-api', config.supabaseUrl), {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      apikey: config.supabasePublishableKey,
    },
    body: '{not valid JSON',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.status, 400, 'Malformed body should be rejected before authentication');
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, 'INVALID_JSON');
});


test('native and verifier builds reproduce exact bytes using one deploy and source timestamp', () => {
  const env = { ...process.env, COMMIT_REF: 'b'.repeat(40),
    DEPLOY_ID: '6ad8954a695249e48e388cae', VERIFIED_PREVIEW_SOURCE_EPOCH: '1792136723' };
  const build = changes => {
    execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: root, env: { ...env, ...changes } });
    return fs.readFileSync(path.join(output, 'platform/index.html'), 'utf8');
  };
  const native = build({});
  assert.ok(native.includes(formatBuildVersion(new Date(1792136723000), env.DEPLOY_ID)), 'release badge must use the source timestamp');
  assert.equal(build({}), native, 'CI verifier must rebuild the exact native artifact, including its badge');
  assert.notEqual(build({ DEPLOY_ID: '6ad8954a695249e48e388cab' }), native, 'new deploys retain distinct badges');
  assert.notEqual(build({ VERIFIED_PREVIEW_SOURCE_EPOCH: '1792136724' }), native, 'wrong source timestamp cannot match');
});

test('reproducible build identity fails closed for malformed provenance', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  assert.equal(buildDate({}, now), now);
  const env = { COMMIT_REF: 'b'.repeat(40), DEPLOY_ID: 'a'.repeat(24), VERIFIED_PREVIEW_SOURCE_EPOCH: '1792136723' };
  assert.equal(buildDate(env).getTime(), 1792136723000);
  for (const change of [{ COMMIT_REF: 'short' }, { DEPLOY_ID: 'wrong' }, { VERIFIED_PREVIEW_SOURCE_EPOCH: '' },
    { VERIFIED_PREVIEW_SOURCE_EPOCH: 'bad' }, { VERIFIED_PREVIEW_SOURCE_EPOCH: '1792136723.1' }]) {
    assert.throws(() => buildDate({ ...env, ...change }), TypeError);
  }
});

