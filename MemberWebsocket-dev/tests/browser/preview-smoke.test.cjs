'use strict';
const { test, expect } = require('playwright/test');
const { validatePreviewTarget } = require('./preview-target.cjs');
const origin = validatePreviewTarget(process.env.PREVIEW_BASE_URL, process.env.COMMIT_REF);
const commit7 = process.env.COMMIT_REF.slice(0, 7);

// This lane never sends auth credentials or writes to the live Supabase project.
// Existing verify-platform-preview.mjs separately checks unauthenticated API/CORS.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
});

test('QA-PREVIEW-001: deployed landing page renders actual navigation and commit', async ({ page }) => {
  const response = await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('navigation', { name: '會員中心入口' })).toBeVisible();
  for (const route of ['member', 'points', 'event', 'calendar', 'booking', 'admin']) {
    await expect(page.locator(`nav a[href="./${route}/"]`)).toHaveCount(1);
  }
  await expect(page.locator('#site-build-version')).toHaveAttribute('data-commit', commit7);
});

test('QA-PREVIEW-002: platform entry renders while unauthenticated workspace stays closed', async ({ page }) => {
  const response = await page.goto(origin + '/platform/', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.locator('main.shell')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  await expect(page.locator('#site-build-version')).toHaveAttribute('data-commit', commit7);
});

for (const width of [390, 1280]) for (const surface of ['member', 'admin']) {
  test(`QA-PREVIEW-136: ${surface} ${width}px preserves the intended navigation without insertBefore errors`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => {
      if (/portal-navigation|insertBefore/.test(error.stack || error.message)) errors.push(error.message);
    });
    await page.setViewportSize({ width, height: 844 });
    const route = surface === 'admin' ? '/admin/workspace.html' : '/member/';
    const response = await page.goto(origin + route, { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    const nav = page.locator('#unifiedPortalNav');
    if (surface === 'member') {
      await expect(nav).toHaveCount(0);
      await expect(page.locator('[data-portal-entry="member"]')).toHaveCount(0);
    } else {
      await expect(nav).toHaveCount(1);
      expect(await nav.evaluate(node => node.parentElement.tagName)).toBe('BODY');
      await expect(nav.locator('a')).toHaveCount(1);
      await expect(nav.locator('a')).toHaveAttribute('href', '/admin/');
    }
    await expect(page.locator('#site-build-version')).toHaveAttribute('data-commit', commit7);
    expect(errors).toEqual([]);
  });
}
