const { test, expect } = require('playwright/test');
const path = require('node:path');
const config = {
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'public-fixture', adminLiffId: 'admin', memberLiffId: 'member',
};
const actions = ['admin.service-grants.add', 'admin.member.force-logout', 'admin.tickets.delete'];

async function mount(page, networkFailure = false) {
  const calls = [];
  await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main>CRUD transport fixture</main>' }));
  await page.route('https://fixture.supabase.co/**', async route => {
    calls.push(route.request().postDataJSON());
    if (networkFailure) await route.abort('failed');
    else await route.fulfill({ json: { ok: true, data: { saved: true } } });
  });
  await page.goto('https://fixture.test/admin/');
  await page.addScriptTag({ path: path.resolve(__dirname, '../../member-system.js') });
  return calls;
}

for (const width of [390, 1280]) {
  for (const action of actions) {
    test(`CRUD AC-001 Chromium ${width}: ${action} is sent once after a network failure`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const calls = await mount(page, true);
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
    const calls = await mount(page);
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
}
