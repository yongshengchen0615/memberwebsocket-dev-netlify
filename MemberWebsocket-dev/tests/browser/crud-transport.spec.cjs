const { test, expect } = require('playwright/test');
const path = require('node:path');
const config = {
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'public-fixture', adminLiffId: 'admin', memberLiffId: 'member',
};
const actions = ['admin.service-grants.add', 'admin.member.force-logout', 'admin.tickets.delete'];

async function mount(page, networkFailure = false) {
  const calls = [], waiting = []; let holdReads = false;
  await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main>CRUD transport fixture</main>' }));
  await page.route('https://fixture.supabase.co/**', async route => {
    const body = route.request().postDataJSON();
    calls.push({ ...body, endpoint: route.request().url() });
    if (holdReads && body.action === 'admin.calendar-items.list') await new Promise(resolve => waiting.push(resolve));
    if (networkFailure) await route.abort('failed');
    else await route.fulfill({ json: { ok: true, data: { saved: true } } });
  });
  await page.goto('https://fixture.test/admin/');
  await page.addScriptTag({ path: path.resolve(__dirname, '../../member-system.js') });
  return { calls, hold() { holdReads = true; }, release() { holdReads = false; waiting.splice(0).forEach(resolve => resolve()); } };
}

for (const width of [390, 1280]) {
  for (const action of actions) {
    test(`CRUD AC-001 Chromium ${width}: ${action} is sent once after a network failure`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { calls } = await mount(page, true);
      const code = await page.evaluate(async ({ config, action }) => {
        try { await MemberSystem.request(config, 'admin', 'identity-A', action, { requestId: 'same-operation' }); return 'unexpected success'; }
        catch (error) { return error.code; }
      }, { config, action });
      expect(code).toBe('API_RESPONSE_UNCERTAIN');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ action, clientType: 'admin', idToken: 'identity-A', requestId: 'same-operation' });
    });
  }
  test(`CRUD AC-001 Chromium ${width}: concurrent writes remain independent and reads still share`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { calls } = await mount(page);
    const results = await page.evaluate(async config => {
      const send = action => MemberSystem.request(config, 'admin', 'identity-A', action, { requestId: 'same-operation' });
      await Promise.all([send('admin.tickets.delete'), send('admin.tickets.delete')]);
      return Promise.all(Array.from({ length: 100 }, () => send('admin.calendar-items.list')));
    }, config);
    expect(calls.filter(call => call.action === 'admin.tickets.delete')).toHaveLength(2);
    expect(calls.filter(call => call.action === 'admin.calendar-items.list')).toHaveLength(1);
    expect(results).toHaveLength(100);
    expect(results.every(result => result.saved === true)).toBe(true);
  });
  test(`CRUD AC-002 Chromium ${width}: the loaded grant extension invalidates pending reads and preserves its endpoint`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const h = await mount(page);
    await page.addScriptTag({ path: path.resolve(__dirname, '../../admin/grant-automation.js') });
    h.hold();
    try {
      await page.evaluate(config => { window.oldRead = MemberSystem.request(config, 'admin', 'identity-A', 'admin.calendar-items.list'); }, config);
      await expect.poll(() => h.calls.length).toBe(1);
      await page.evaluate(config => MemberSystem.request(config, 'admin', 'identity-A', 'admin.member-grants.add', { requestId: 'grant-once', points: 2 }), config);
      await page.evaluate(config => { window.freshRead = MemberSystem.request(config, 'admin', 'identity-A', 'admin.calendar-items.list'); }, config);
      await expect.poll(() => h.calls.length).toBe(3);
      expect(h.calls[1]).toMatchObject({ endpoint: config.supabaseUrl + '/functions/v1/grant-automation', notificationMode: 'immediate', requestId: 'grant-once', points: 2 });
      h.release();
      await page.evaluate(() => Promise.all([window.oldRead, window.freshRead]));
    } finally { h.release(); }
  });
}

for (const width of [390, 1280]) {
  for (const envelope of [{ ok: true }, { ok: true, data: {}, error: { code: 'DATABASE_ERROR' } }]) {
    test(`CRUD-LOG AC-001 Chromium ${width}: booking rejects ${JSON.stringify(envelope)} without replay`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { calls } = await mount(page);
      await page.route('https://fixture.supabase.co/**', route => {
        calls.push(route.request().postDataJSON());
        return route.fulfill({ json: envelope });
      });
      await page.addScriptTag({ path: path.resolve(__dirname, '../../booking/common.js') });
      const code = await page.evaluate(async config => {
        try { await BookingSystem.request(config, 'member', 'identity-A', 'user.booking.group.create', { requestId: 'save-once' }); return 'unexpected success'; }
        catch (error) { return error.code; }
      }, config);
      expect(code).toBe('API_RESPONSE_UNCERTAIN');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ action: 'user.booking.group.create', requestId: 'save-once' });
    });
  }
  test(`CRUD-LOG AC-002 Chromium ${width}: switching merchant rejects a delayed booking write`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { calls } = await mount(page);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('https://fixture.supabase.co/**', async route => {
      calls.push(route.request().postDataJSON());
      await held;
      await route.fulfill({ json: { ok: true, data: { bookingId: 'saved' } } });
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../booking/common.js') });
    await page.evaluate(config => {
      window.BusinessContext = { slug: 'shop-a', generation: 1 };
      window.writeResult = BookingSystem.request(config, 'member', 'identity-A', 'user.booking.group.create')
        .then(() => 'unexpected success', error => error.code);
    }, config);
    await expect.poll(() => calls.length).toBe(1);
    await page.evaluate(() => { BusinessContext.slug = 'shop-b'; BusinessContext.generation++; });
    release();
    expect(await page.evaluate(() => window.writeResult)).toBe('API_RESPONSE_UNCERTAIN');
    expect(calls).toHaveLength(1);
  });
}
