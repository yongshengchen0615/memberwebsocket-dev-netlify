const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const output = path.join(projectRoot, 'dist');
const surfaces = ['', 'admin', 'member', 'points', 'event', 'calendar', 'booking'];
let server;
let base;

test.beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: projectRoot });
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = path.resolve(output, '.' + pathname);
    if (file === output || (fs.existsSync(file) && fs.statSync(file).isDirectory())) {
      file = path.join(file, 'index.html');
    }
    if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) {
      // Isolate deployed HTML + CSS from unrelated login/network scripts,
      // while preserving the actual page CSP and its mobile styles.
      body = Buffer.from(body.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

for (const width of [320, 390, 1280]) {
  test(`published site version stays visible on ${width}px screens, including mobile`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 760 });
    const seen = new Set();
    for (const surface of surfaces) {
      await page.goto(`${base}/${surface ? surface + '/' : ''}`, { waitUntil: 'load' });
      const badge = page.locator('#site-build-version');
      await expect(badge, `${surface || 'home'} should have exactly one badge`).toHaveCount(1);
      await expect(badge).toBeVisible();
      const displayed = await badge.textContent();
      expect(displayed).toMatch(/^v\d{6}\.\d{6}-[a-z0-9]{6}$/);
      seen.add(displayed);
      const geometry = await badge.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          position: style.position, zIndex: style.zIndex, opacity: Number(style.opacity),
          pointerEvents: style.pointerEvents, width: rect.width, height: rect.height,
        };
      });
      expect(geometry.position).toBe('fixed');
      expect(Number(geometry.zIndex)).toBeGreaterThan(1000);
      expect(geometry.pointerEvents).toBe('none');
      expect(geometry.opacity).toBeGreaterThan(0.5);
      expect(geometry.width).toBeGreaterThan(20);
      expect(geometry.height).toBeGreaterThan(8);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(760);
      expect(await badge.evaluate(node => node.hasAttribute('style'))).toBe(false);
      if (width === 390 && ['admin', 'member', 'booking'].includes(surface)) {
        const image = await page.screenshot({ animations: 'disabled' });
        await info.attach(`version-${surface}-mobile`, { body: image, contentType: 'image/png' });
      }
    }
    expect(seen.size).toBe(1);
  });
}
