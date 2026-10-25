'use strict';
// Companion mobile/JS-console evidence for BrowserAct smoke, using the repository's
// existing pinned Playwright. Anonymous preview ONLY; no login or mutations.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const playwrightRequire = createRequire(path.resolve(__dirname, '../MemberWebsocket-dev/tests/browser/package.json'));
const { chromium, devices } = playwrightRequire('playwright');

const base = process.env.TARGET_URL || '';
const routes = { home: '/', member: '/member/', booking: '/booking/', points: '/points/', admin: '/admin/' };
const allowed = ['integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app',
                 'develop--memberwebsocket-dev-netlify.netlify.app'];
const output = path.resolve(__dirname, '../evidence/browseract');
const host = new URL(base).hostname;
if (new URL(base).protocol !== 'https:' || !allowed.includes(host) ||
    new URL(base).pathname !== '/' || new URL(base).search || new URL(base).hash) {
  console.error('SECURITY: Mobile tests require an allowlisted preview root');
  process.exit(2);
}
fs.mkdirSync(output, { recursive: true });

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch (_) { return '[UNPARSEABLE_URL]'; }
}
function normalizeError(message) {
  return String(message).replace(/https:\/\/access\.line\.me\/\S+/g, 'https://access.line.me/[REDACTED]').slice(0, 400);
}
async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [name, pathname] of Object.entries(routes)) {
      const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-TW' });
      const page = await context.newPage();
      const errors = [];
      const responseFailures = [];
      page.on('pageerror', e => errors.push(normalizeError(e.message)));
      page.on('console', m => {
        if (m.type() === 'error') errors.push(normalizeError(m.text()));
      });
      page.on('response', r => {
        if (r.status() < 400) return;
        try {
          const u = new URL(r.url());
          if (u.hostname !== host) return;
          const type = r.request().resourceType();
          responseFailures.push({ status: r.status(), resourceType: type, url: sanitizeUrl(r.url()) });
        } catch (_) {}
      });
      const item = { page: name, type: 'mobile-playwright-companion', viewport: 'iPhone 13',
                     status: 'FAILED', httpStatus: null, finalHost: null,
                     overflowPixels: null, jsErrors: [], httpFailures: [], screenshot: name + '-mobile.png' };
      try {
        const response = await page.goto(base + pathname, { waitUntil: 'domcontentloaded', timeout: 45000 });
        item.httpStatus = response ? response.status() : null;
        await page.waitForTimeout(2500);
        const final = new URL(page.url());
        item.finalHost = final.hostname;
        item.finalPath = final.pathname;
        if (final.hostname === 'access.line.me' && final.pathname.startsWith('/oauth2/')) {
          item.status = 'AUTH_REQUIRED';
          item.note = 'LINE authentication gate; no credentials were entered';
        } else if (final.hostname !== host) {
          item.errors = ['Unexpected destination ' + final.hostname];
        } else {
          const dom = await page.evaluate(() => ({
            title: document.title, bodyLength: (document.body?.innerText || '').trim().length,
            viewportWidth: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            readyState: document.readyState,
          }));
          item.title = dom.title;
          item.bodyLength = dom.bodyLength;
          item.overflowPixels = Math.max(0, dom.scrollWidth - dom.viewportWidth);
          item.jsErrors = errors;
          item.httpFailures = responseFailures;
          const fatalHttp = responseFailures.filter(x => ['document', 'script', 'stylesheet'].includes(x.resourceType));
          item.status = item.httpStatus === 200 && dom.bodyLength > 0 &&
                        item.overflowPixels <= 16 && !errors.length && !fatalHttp.length
                        ? 'PASS' : 'FAILED';
        }
        await page.screenshot({ path: path.join(output, item.screenshot), fullPage: true });
      } catch (e) {
        item.errors = [normalizeError(e.message)];
      } finally {
        results.push(item);
        await context.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, 'mobile-results.json'), JSON.stringify(results, null, 2));
  for (const item of results) {
    console.log(item.page + ': ' + item.status + ' (' + (item.finalHost || 'navigation-error') + ')');
  }
  if (results.some(x => x.status === 'FAILED')) process.exitCode = 1;
}
main().catch(e => { console.error(normalizeError(e.message)); process.exitCode = 1; });
