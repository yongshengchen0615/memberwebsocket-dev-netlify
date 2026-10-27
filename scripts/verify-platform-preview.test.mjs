import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyPlatformPreview, previewPages, previewAssets } from './verify-platform-preview.mjs';

const commit = 'a'.repeat(40);
const base = 'https://preview.example';
const api = 'https://backend.example/functions/v1/platform-api';

async function fixture(t, mutate = () => {}) {
  const dist = await mkdtemp(path.join(tmpdir(), 'preview-smoke-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  const files = new Map();
  for (const [url, file] of [...previewPages, ...previewAssets]) {
    const body = file.endsWith('.html')
      ? `<html><small id="site-build-version" data-commit="${commit.slice(0, 7)}">v261021.000000-abcdef</small></html>`
      : file === 'config.json' ? JSON.stringify({ platformLiffId: '2012065297-VunxFBj8' }) : `asset:${file}`;
    await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
    await writeFile(path.join(dist, file), body);
    files.set(url, body);
  }
  const checks = [];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: String(url), method: options.method || 'GET' });
    let response;
    if (String(url) === api) {
      response = options.method === 'OPTIONS'
        ? new Response(null, { status: 204, headers: { 'access-control-allow-origin': base, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin' } })
        : Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: { 'access-control-allow-origin': base, 'cache-control': 'no-store' } });
    } else if (parsed.pathname === '/admin/platform/') {
      response = new Response(null, { status: 301, headers: { location: '/platform/' } });
    } else {
      response = new Response(files.get(parsed.pathname) ?? 'missing', { status: files.has(parsed.pathname) ? 200 : 404 });
    }
    return await mutate({ url: String(url), options, response, calls }) || response;
  };
  return { dist, calls, checks, options: { base, api, commit, dist, fetchImpl, attempts: 2, delayMs: 0, onCheck: check => checks.push(check) } };
}

test('verifies all ten pages, exact asset bytes, legacy redirect, preflight and authentication', async t => {
  const f = await fixture(t);
  const result = await verifyPlatformPreview(f.options);
  assert.equal(result.passedChecks, previewPages.length + previewAssets.length + 3);
  assert.equal(result.commit, commit);
  assert.ok(f.calls.some(x => x.url.endsWith('/booking/admin/')));
  assert.ok(f.checks.every(x => x.ok));
  assert.ok(f.calls.some(x => x.url === api && x.method === 'POST'));
});

test('the success summary preserves per-resource diagnostics when added to the saved report', async t => {
  const f = await fixture(t);
  const result = await verifyPlatformPreview(f.options);
  const report = { checks: f.checks };
  Object.assign(report, result, { ok: true });
  assert.equal(report.checks, f.checks);
  assert.equal(report.checks.length, 22);
  assert.equal(report.passedChecks, 22);
});

test('each changed UI script must match exact artifact bytes', async t => {
  for (const file of ['/admin/business-line-settings.js', '/admin/booking-risk.js', '/points/point-transfer.js']) {
    const f = await fixture(t, ({ url }) => new URL(url).pathname === file ? new Response('stale UI script') : undefined);
    await assert.rejects(verifyPlatformPreview(f.options), /remote bytes do not match/);
  }
});

test('isolated member preview APIs must pass preflight and reject missing LINE identity', async t => {
  const f = await fixture(t);
  const endpoints = ['api-preview', 'member-profile-api-preview'].map(name => `https://backend.example/functions/v1/${name}`);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (!endpoints.includes(String(url))) return f.options.fetchImpl(url, options);
    calls.push({ url: String(url), method: options.method });
    return options.method === 'OPTIONS'
      ? new Response(null, { status: 204, headers: { 'access-control-allow-origin': base } })
      : Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: { 'access-control-allow-origin': base, 'cache-control': 'no-store' } });
  };
  const result = await verifyPlatformPreview({ ...f.options, memberApis: endpoints, fetchImpl });
  assert.equal(result.passedChecks, 26);
  assert.equal(calls.length, 4);
  await assert.rejects(verifyPlatformPreview({ ...f.options, memberApis: endpoints,
    fetchImpl: (url, options) => endpoints.includes(String(url)) && options.method === 'POST'
      ? Response.json({ ok: true }) : fetchImpl(url, options),
  }), /must reject without identity/);
});

test('a transient asset HTTP 500 is diagnosed and must pass the same byte check on retry', async t => {
  let seen = 0;
  const f = await fixture(t, ({ url }) => url.endsWith('/platform/app.js') && ++seen === 1
    ? new Response('internal failure', { status: 500, headers: { 'x-nf-request-id': 'request-500' } }) : undefined);
  await verifyPlatformPreview(f.options);
  assert.equal(seen, 2);
  assert.ok(f.checks.some(x => x.status === 500 && x.requestId === 'request-500' && !x.ok));
});

test('persistent HTTP 500 fails with the exact resource in its error', async t => {
  const f = await fixture(t, ({ url }) => url.endsWith('/config.json') ? new Response('failure', { status: 500 }) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /config\.json.*HTTP 500/);
});

test('removed LINE login gate cannot reappear in a local Platform release', async t => {
  const f = await fixture(t);
  const file = path.join(f.dist, 'platform/index.html');
  await writeFile(file, `<html><small data-commit="${commit.slice(0, 7)}"></small><section id="platformLoginGate"></section></html>`);
  await assert.rejects(verifyPlatformPreview(f.options), /retired LINE login gate/);
  assert.equal(f.calls.length, 0, 'invalid local bundle must fail before deployment traffic');
});

test('removed LINE login handlers cannot reappear in the shipped app bundle', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dist, 'platform/app.js'), 'el("platformLoginButton").addEventListener("click",login);');
  await assert.rejects(verifyPlatformPreview(f.options), /retired LINE login gate handlers/);
  assert.equal(f.calls.length, 0);
});

test('stale HTML with a different commit never passes', async t => {
  const f = await fixture(t, ({ url, response }) => url.endsWith('/member/') ? response.text().then(body => new Response(body.replace('aaaaaaa', 'bbbbbbb'))) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /member\/.*commit/);
});

test('same-commit HTML from another build is rejected by artifact digest', async t => {
  const f = await fixture(t, ({ url, response }) => url.endsWith('/admin/') ? response.text().then(body => new Response(body + '<!-- another build -->')) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /admin\/.*artifact/);
});

test('a 200 asset with the wrong content cannot pass', async t => {
  const f = await fixture(t, ({ url }) => url.endsWith('/booking/calendar-flow.js') ? new Response('old source') : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /calendar-flow\.js.*artifact/);
});

test('wrong redirect destination is rejected', async t => {
  const f = await fixture(t, ({ url }) => url.endsWith('/admin/platform/') ? new Response(null, { status: 301, headers: { location: '/admin/' } }) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /redirect/);
});

test('API success without a token fails immediately and is never retried', async t => {
  const f = await fixture(t, ({ url, options }) => url === api && options.method === 'POST' ? Response.json({ ok: true }) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /HTTP 401/);
  assert.equal(f.calls.filter(x => x.url === api && x.method === 'POST').length, 1);
});

test('authentication rejection without origin-scoped CORS fails', async t => {
  const f = await fixture(t, ({ url, options }) => url === api && options.method === 'POST' ? Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /CORS/);
});

test('malformed API responses fail without copying response contents into diagnostics', async t => {
  const secret = 'response-content-must-not-be-logged';
  const f = await fixture(t, ({ url, options, response }) => url === api && options.method === 'POST'
    ? new Response(secret, { status: 401, headers: response.headers }) : undefined);
  await assert.rejects(verifyPlatformPreview(f.options), /valid JSON/);
  assert.equal(JSON.stringify(f.checks).includes(secret), false);
});

test('wrong auth error code, caching or preflight status cannot pass', async t => {
  for (const failure of ['error-code', 'cache', 'preflight']) {
    const f = await fixture(t, ({ url, options, response }) => {
      if (url !== api) return;
      if (failure === 'preflight' && options.method === 'OPTIONS') return new Response(null, { status: 403 });
      if (options.method !== 'POST') return;
      if (failure === 'cache') response.headers.set('cache-control', 'public');
      if (failure === 'error-code') return Response.json({ error: { code: 'WRONG_ERROR' } }, { status: 401, headers: response.headers });
    });
    await assert.rejects(verifyPlatformPreview(f.options), /AUTH_REQUIRED|no-store|HTTP 204/);
  }
});

test('transport failures retain diagnostics and persistent failures remain fatal', async t => {
  const f = await fixture(t, ({ url }) => { if (url.endsWith('/platform/')) throw new Error('network unavailable'); });
  await assert.rejects(verifyPlatformPreview(f.options), /platform\/.*network unavailable/);
  const failed = f.checks.filter(x => x.url === base + '/platform/');
  assert.equal(failed.length, 2);
  assert.ok(failed.every(x => x.ok === false && x.status === null));
  assert.equal(f.checks.filter(x => x.url === base + '/' && x.ok).length, 1);
});

test('invalid commit or retry limits fail before issuing HTTP requests', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyPlatformPreview({ ...f.options, commit: 'local' }), /40-character/);
  await assert.rejects(verifyPlatformPreview({ ...f.options, attempts: 0 }), /attempts/);
  assert.equal(f.calls.length, 0);
});

