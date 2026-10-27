'use strict';
const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'portal-navigation.js'), 'utf8');
const actualPage = file => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const cases = [
  { name: 'member nested shell', html: actualPage('member/index.html'), surface: 'member', before: 'app' },
  { name: 'admin workspace', html: actualPage('admin/workspace.html'), surface: 'admin' },
  { name: 'direct main after another child', html: '<html data-portal-surface="member"><body><div id="first"></div><main id="content"></main></body></html>', surface: 'member', before: 'content' },
  { name: 'empty body', html: '<html data-portal-surface="admin"><body></body></html>', surface: 'admin' },
  { name: 'platform excluded', html: actualPage('platform/index.html'), surface: 'platform' },
];

for (const width of [390, 1280]) for (const timing of ['loading', 'ready']) for (const fixture of cases) {
  test(`AC-136 ${fixture.name} ${width}px ${timing}: valid insertion, role isolation and one mount`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    // Keep the real page structure; only the shared navigation runs. No LINE/API writes.
    await page.route('**/*', route => route.abort());
    const html = timing === 'loading'
      ? fixture.html.replace('</body>', `<script>${script}</script></body>`)
      : fixture.html;
    await page.setContent(html);
    if (timing === 'ready') await page.addScriptTag({ content: script });
    const nav = page.locator('#unifiedPortalNav');
    if (fixture.surface === 'platform') {
      await expect(nav).toHaveCount(0);
    } else {
      await expect(nav).toHaveCount(1);
      expect(await nav.evaluate(node => node.parentElement.tagName)).toBe('BODY');
      if (fixture.before) expect(await nav.evaluate(node => node.nextElementSibling.id)).toBe(fixture.before);
      await expect(nav.locator('a')).toHaveCount(1);
      await expect(nav.locator('a')).toHaveAttribute('href', `/${fixture.surface}/`);
      await expect(nav.locator('a')).toHaveAttribute('aria-current', 'page');
      await page.addScriptTag({ content: script });
      await expect(nav).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });
}
