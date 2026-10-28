import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const previewPages = [
  ['/', 'index.html'],
  ['/platform/', 'platform/index.html'], ['/admin/', 'admin/index.html'],
  ['/admin/workspace.html', 'admin/workspace.html'], ['/member/', 'member/index.html'],
  ['/points/', 'points/index.html'], ['/event/', 'event/index.html'],
  ['/calendar/', 'calendar/index.html'], ['/booking/', 'booking/index.html'],
  ['/booking/admin/', 'booking/admin/index.html'],
];
export const previewAssets = [
  ['/platform/app.js', 'platform/app.js'], ['/config.json', 'config.json'],
  ['/booking/calendar-flow.js', 'booking/calendar-flow.js'],
  ['/booking/member-ui.js', 'booking/member-ui.js'], ['/version-badge.css', 'version-badge.css'],
  ['/admin/business-line-settings.js', 'admin/business-line-settings.js'],
  ['/admin/booking-risk.js', 'admin/booking-risk.js'], ['/points/point-transfer.js', 'points/point-transfer.js'],
  ['/member-system.js', 'member-system.js'],
  ['/member/member-invitations.js', 'member/member-invitations.js'], ['/member/app.js', 'member/app.js'],
];
const digest = body => createHash('sha256').update(body).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifyPlatformPreview({
  base, commit, dist, api, memberApis = [], memberRuntimeRequired = false, fetchImpl = fetch, attempts = 3, delayMs = 2000,
  timeoutMs = 20000, onCheck = () => {},
}) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('A full 40-character commit SHA is required');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('attempts must be between 1 and 5');
  const origin = new URL(base).origin;
  for (const endpoint of memberApis) {
    const url = new URL(endpoint);
    if (url.origin !== new URL(api).origin || !/^\/functions\/v1\/(api-preview|member-profile-api-preview|member-growth-api-preview)$/.test(url.pathname)
      || url.search || url.hash || url.username || url.password) throw new Error('Unexpected member preview API');
  }
  const expected = [];
  // Read and validate the whole local artifact before making any network calls.
  for (const [url, file] of [...previewPages, ...previewAssets]) {
    const body = await readFile(path.join(dist, file));
    if (file.endsWith('.html') && !body.toString().includes(`data-commit="${commit.slice(0, 7)}"`)) {
      throw new Error(`${file}: local artifact does not match commit ${commit}`);
    }
    if (file === 'platform/index.html' && /id=["']platformLogin(?:Gate|Button)["']/.test(body.toString())) {
      throw new Error('platform/index.html: retired LINE login gate must not be published');
    }
    if (file === 'platform/app.js' && /platformLogin(?:Gate|Button)/.test(body.toString())) {
      throw new Error('platform/app.js: retired LINE login gate handlers must not be published');
    }
    if (file === 'config.json') {
      const config = JSON.parse(body);
      if (config.platformLiffId !== '2012065297-VunxFBj8') throw new Error('config.json: incorrect platform LIFF identity');
      if (memberRuntimeRequired) {
        const expectedApis = ['api-preview', 'member-profile-api-preview', 'member-growth-api-preview'].map(name => new URL('/functions/v1/' + name, new URL(api).origin).href);
        if (config.supabaseFunctionUrl !== new URL('/functions/v1/api', new URL(api).origin).href
          || config.previewApiFunctionUrl !== expectedApis[0] || config.memberProfileFunctionUrl !== expectedApis[1]
          || config.memberGrowthFunctionUrl !== expectedApis[2]
          || memberApis.length !== 3 || memberApis.some((url,index) => url !== expectedApis[index])) {
          throw new Error('config.json: required member preview routes are missing or incorrect');
        }
      }
    }
    expected.push({ url, file, hash: digest(body) });
  }
  let checks = 0;
  async function check(url, options, validate, limit = attempts) {
    let failure;
    for (let attempt = 1; attempt <= limit; attempt++) {
      let response;
      const started = Date.now();
      try {
        response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
        const body = Buffer.from(await response.arrayBuffer());
        validate(response, body);
        onCheck({ url, method: options.method || 'GET', attempt, status: response.status, ok: true,
          requestId: response.headers.get('x-nf-request-id'), durationMs: Date.now() - started });
        checks++;
        return;
      } catch (error) {
        failure = new Error(`${url}: ${error.message}`);
        // Never log response bodies: an unexpected service response may contain secrets.
        onCheck({ url, method: options.method || 'GET', attempt, status: response?.status ?? null, ok: false,
          requestId: response?.headers.get('x-nf-request-id') ?? null, durationMs: Date.now() - started,
          error: error.message });
        if (attempt < limit) await pause(delayMs);
      }
    }
    throw failure;
  }
  for (const item of expected) {
    await check(new URL(item.url, origin).href, { redirect: 'error' }, (response, body) => {
      if (response.status !== 200) throw new Error(`expected HTTP 200, got HTTP ${response.status}`);
      if (item.file.endsWith('.html') && !body.toString().includes(`data-commit="${commit.slice(0, 7)}"`)) {
        throw new Error('remote commit does not match the release');
      }
      if (digest(body) !== item.hash) throw new Error('remote bytes do not match the exact local artifact');
    });
  }
  for (const [url, status] of [['/admin/platform/', 301]]) {
    await check(new URL(url, origin).href, { redirect: 'manual' }, response => {
      const target = new URL(response.headers.get('location') || '/', origin);
      if (response.status !== status || target.origin !== origin || target.pathname !== '/platform/' || target.search || target.hash) {
        throw new Error('incorrect platform redirect');
      }
    });
  }
  // Authorization failures are final, never retried into an eventual success.
  await check(api, { method: 'OPTIONS', redirect: 'error', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } }, response => {
    if (response.status !== 204) throw new Error(`preflight expected HTTP 204, got HTTP ${response.status}`);
    if (response.headers.get('access-control-allow-origin') !== origin
      || !/\bPOST\b/.test(response.headers.get('access-control-allow-methods') || '')
      || !/\bcontent-type\b/i.test(response.headers.get('access-control-allow-headers') || '')
      || !/\bOrigin\b/i.test(response.headers.get('vary') || '')) throw new Error('preflight CORS contract failed');
  }, 1);
  await check(api, { method: 'POST', redirect: 'error', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'platform.bootstrap' }),
  }, (response, body) => {
    if (response.status !== 401) throw new Error(`unauthenticated request expected HTTP 401, got HTTP ${response.status}`);
    if (response.headers.get('access-control-allow-origin') !== origin) throw new Error('authentication CORS contract failed');
    if (!/\bno-store\b/i.test(response.headers.get('cache-control') || '')) throw new Error('authentication response must be no-store');
    let payload;
    try { payload = JSON.parse(body); }
    catch { throw new Error('authentication response must contain valid JSON'); }
    if (payload.error?.code !== 'AUTH_REQUIRED') throw new Error('expected AUTH_REQUIRED rejection');
  }, 1);
  for (const endpoint of memberApis) {
    await check(endpoint, { method: 'OPTIONS', redirect: 'error', headers: { Origin: origin,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,apikey' } }, response => {
      const headers = (response.headers.get('access-control-allow-headers') || '').toLowerCase().split(',').map(value=>value.trim());
      if (response.status !== 204 || response.headers.get('access-control-allow-origin') !== origin
        || !/\bPOST\b/.test(response.headers.get('access-control-allow-methods') || '')
        || !headers.includes('content-type') || !headers.includes('apikey')
        || !/\bOrigin\b/i.test(response.headers.get('vary') || '')) throw new Error('member preview preflight contract failed');
    }, 1);
    await check(endpoint, { method: 'POST', redirect: 'error', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'user.member.profile.save', clientType: 'member' }),
    }, (response, body) => {
      let payload;
      try { payload = JSON.parse(body); } catch { throw new Error('member preview authentication response must contain valid JSON'); }
      if (response.status !== 401 || response.headers.get('access-control-allow-origin') !== origin
        || !/\bno-store\b/i.test(response.headers.get('cache-control') || '')
        || payload.error?.code !== 'AUTH_REQUIRED') throw new Error('member preview authentication must reject without identity');
    }, 1);
  }
  return { commit, origin, passedChecks: checks };
}

async function main() {
  const checks = [];
  const reportPath = process.env.PREVIEW_REPORT_PATH || 'evidence/platform-preview-smoke.json';
  const report = { commit: process.env.COMMIT_REF, startedAt: new Date().toISOString(), checks, ok: false };
  try {
    const config = JSON.parse(await readFile('dist/config.json', 'utf8'));
    const result = await verifyPlatformPreview({ base: process.env.PREVIEW_BASE_URL, commit: process.env.COMMIT_REF,
      dist: 'dist', api: new URL('/functions/v1/platform-api', config.supabaseUrl).href,
      memberApis: config.memberProfileFunctionUrl ? [config.previewApiFunctionUrl, config.memberProfileFunctionUrl, config.memberGrowthFunctionUrl] : [],
      memberRuntimeRequired: (process.env.PREVIEW_SOURCE_BRANCH || process.env.GITHUB_REF_NAME) === 'Integrated-Marketing-Platform',
      onCheck: check => { checks.push(check); console.log(JSON.stringify(check)); },
    });
    Object.assign(report, result, { ok: true });
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

