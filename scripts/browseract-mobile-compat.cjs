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
      page.on('pageerror', e => errors.push({message: normalizeError(e.message), stack: normalizeError(e.stack || '').slice(0, 1600)}));
      page.on('console', m => {
        if (m.type() === 'error') errors.push({message: normalizeError(m.text()), source: 'console'});
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
        let dom;
        for (let attempt = 0; attempt < 8; attempt++) {
          // LIFF frequently replaces the document while verifying LINE identity.
          await page.waitForTimeout(attempt === 0 ? 2500 : 900);
          const final = new URL(page.url());
          item.finalHost = final.hostname;
          item.finalPath = final.pathname;
          if (final.hostname === 'access.line.me' && final.pathname.startsWith('/oauth2/')) {
            item.status = 'AUTH_REQUIRED';
            item.note = 'LINE authentication gate; no credentials were entered';
            break;
          }
          if (final.hostname !== host) {
            item.errors = ['Unexpected destination ' + final.hostname];
            break;
          }
          try {
            dom = await page.evaluate(() => ({
              title: document.title, text: (document.body?.innerText || '').trim().slice(0, 400),
              bodyLength: (document.body?.innerText || '').trim().length,
              viewportWidth: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              readyState: document.readyState,
            }));
            if (/(正在驗證 LINE 身分|正在登入會員卡|正在登入會員|LINE 身分驗證)/.test(dom.text)) {
              item.status = 'AUTH_PENDING';
              item.note = 'LIFF is still checking LINE identity; protected UI not yet validated';
            }
            break;
          } catch (e) {
            if (!/Execution context was destroyed|Navigation|navigation|closed/i.test(e.message) || attempt === 7) throw e;
          }
        }
        item.jsErrors = errors;
        item.httpFailures = responseFailures;
        if (dom) {
          item.title = dom.title;
          item.bodyLength = dom.bodyLength;
          item.overflowPixels = Math.max(0, dom.scrollWidth - dom.viewportWidth);
          if (item.status !== 'AUTH_PENDING') {
            const fatalHttp = responseFailures.filter(x => ['document', 'script', 'stylesheet'].includes(x.resourceType));
            item.status = item.httpStatus === 200 && dom.bodyLength > 0 &&
                          item.overflowPixels <= 16 && !errors.length && !fatalHttp.length
                          ? 'PASS' : 'FAILED';
          }
        }
        // An uncaught application exception is a failure even if LINE login is still pending.
        if (item.finalHost === host && errors.length) {
          item.status = 'FAILED';
          item.note = 'Uncaught JavaScript exception while preparing authenticated UI';
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
