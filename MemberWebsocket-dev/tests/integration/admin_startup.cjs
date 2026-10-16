const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '../..');

// Run in a separate process: an observer loop starves even in-process test timers.
if (!process.argv.includes('--fixture')) {
  for (const mode of ['early', 'late', 'forbidden']) {
    test(`admin startup and fixed-ticket observers settle (${mode})`, () => {
      const result = spawnSync(process.execPath, [__filename, '--fixture', mode], {
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined, 'Admin event loop must not starve timers');
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
} else {
  runFixture(process.argv.at(-1)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function runFixture(mode) {
  const navigationAttempts = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    // JSDOM cannot navigate; observe reload attempts at its browser boundary.
    if (/Not implemented: navigation/.test(error.message)) navigationAttempts.push(error.message);
    else throw error;
  });
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'https://example.test/MemberWebsocket-dev/admin/', virtualConsole,
  });
  const w = dom.window;
  const el = (id) => w.document.getElementById(id);
  const tick = () => new Promise((resolve) => w.setTimeout(resolve, 20));
  const calls = [];
  const errors = [];
  let subscriptions = 0;
  let stoppedSubscriptions = 0;
  let adminRequests = 0;
  w.addEventListener('error', (event) => errors.push(event.message));
  w.Request = Request;
  w.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, data: { templates: [] } }));
  };
  w.liff = { getIDToken: () => 'fixture-token' };
  w.MemberSystem = {
    bindDialogKeyboard() {},
    loadConfig: async () => ({ supabaseUrl: 'https://fixture.supabase.co' }),
    signIn: async () => 'fixture-token',
    request: async () => {
      adminRequests += 1;
      if (mode === 'forbidden') throw Object.assign(new Error('Access denied'), { code: 'ADMIN_FORBIDDEN' });
      return {
        profile: { displayName: 'Fixture Admin' }, role: 'Admin',
        memberPage: { page: 1, pageSize: 100, total: 0, totalPages: 1 },
        members: [], tierSettings: [], cards: [], tickets: [], eventTickets: [],
        calendarItems: [], messagePresets: [], stats: {},
      };
    },
    subscribeRealtime() { subscriptions += 1; return () => { stoppedSubscriptions += 1; }; },
  };
  const load = (name) => w.eval(fs.readFileSync(path.join(root, 'admin', name), 'utf8'));
  try {
    load('admin-session.js');
    load('coupon-location-editor.js');
    load('app.js');
    if (mode === 'late') await tick();
    load('fixed-ticket-admin-integration.js');
    load('fixed-ticket-calendar-option.js');
    load('fixed-ticket-admin.js');
    await tick();
    await tick();

    assert.deepEqual(errors, []);
    assert.equal(el('loadingView').classList.contains('hidden'), true);
    assert.equal(el('app').getAttribute('aria-busy'), 'false');
    if (mode === 'forbidden') {
      assert.equal(el('adminView').classList.contains('hidden'), true);
      assert.equal(el('errorView').classList.contains('hidden'), false);
      assert.equal(el('errorTitle').textContent, '沒有管理端權限');
      assert.equal(subscriptions, 0);
      return;
    }
    assert.equal(el('adminView').classList.contains('hidden'), false);
    assert.equal(el('errorView').classList.contains('hidden'), true);
    assert.equal(subscriptions, 1);
    el('eventsTab').click();
    el('newEventTicketButton').click();
    await tick();
    assert.equal(el('eventTicketEditorModal').classList.contains('hidden'), false);

    const help = el('eventTicketAllowedTiers').querySelector('p');
    const originalHelp = help.textContent;
    el('eventTicketType').value = 'fixed';
    el('eventTicketType').dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick();
    assert.match(help.textContent, /符合所選會員等級才會自動取得並可使用/);
    assert.match(help.textContent, /日曆呈現依「會員階級顯示規則」/);
    assert.match(help.textContent, /鎖定預覽不可領取或使用/);
    assert.equal(w.document.querySelectorAll('#fixedTicketCalendarEnabled').length, 1);

    // Unrelated form mutations must settle without rewriting unchanged help.
    let helpChanges = 0;
    const observer = new w.MutationObserver((records) => { helpChanges += records.length; });
    observer.observe(help, { childList: true, subtree: true });
    el('eventTicketFormMessage').textContent = 'Fixture update';
    await tick();
    assert.equal(helpChanges, 0);
    observer.disconnect();

    const endpoint = 'https://fixture.supabase.co/functions/v1/fixed-ticket-automation';
    for (const enabled of [true, false]) {
      el('fixedTicketCalendarEnabled').checked = enabled;
      el('fixedTicketCalendarEnabled').dispatchEvent(new w.Event('change'));
      await tick();
      await w.fetch(endpoint, {
        method: 'POST', body: JSON.stringify({ action: 'admin.fixed-tickets.save',
          idToken: 'fixture-token', expectedUpdatedAt: 'fixture-version', template: { title: 'Fixture' } }),
      });
      const sent = JSON.parse(calls.at(-1).init.body);
      assert.equal(sent.template.calendarEnabled, enabled);
      assert.equal(sent.template.title, 'Fixture');
      assert.equal(sent.idToken, 'fixture-token');
      assert.equal(sent.expectedUpdatedAt, 'fixture-version');
    }
    const otherInit = { method: 'POST', body: 'unchanged' };
    await w.fetch('https://example.test/other', otherInit);
    assert.equal(calls.at(-1).init, otherInit);

    el('eventTicketType').value = 'coupon';
    el('eventTicketType').dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick();
    assert.equal(help.textContent, originalHelp);

    // System-managed birthday calendar entries must remain protected.
    el('calendarItemStatus').value = 'targeted';
    el('calendarItemEditorStatus').textContent = '壽星限定';
    await tick();
    assert.equal(el('saveCalendarItemButton').disabled, true);
    assert.equal(el('deleteCalendarItemButton').disabled, true);
    const submit = new w.Event('submit', { bubbles: true, cancelable: true });
    el('calendarItemForm').dispatchEvent(submit);
    assert.equal(submit.defaultPrevented, true);
    el('calendarItemStatus').value = 'active';
    el('calendarItemId').value = 'fixture-calendar-id';
    el('calendarItemEditorStatus').textContent = '啟用中';
    await tick();
    assert.equal(el('saveCalendarItemButton').disabled, false);
    assert.equal(el('deleteCalendarItemButton').disabled, false);
    assert.deepEqual(errors, []);

    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: false }));
    assert.equal(navigationAttempts.length, 0);
    w.dispatchEvent(new w.PageTransitionEvent('pagehide', { persisted: true }));
    assert.equal(el('adminView').classList.contains('hidden'), true);
    assert.equal(el('eventTicketEditorModal').classList.contains('hidden'), true);
    assert.equal(stoppedSubscriptions, 1);
    const requestsBeforeResume = adminRequests;
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));
    await tick();
    await tick();
    assert.equal(navigationAttempts.length, 0, 'Back/Forward cache restore must not hard reload');
    assert.ok(adminRequests > requestsBeforeResume, 'Back/Forward cache restore must revalidate through the server');
    assert.equal(el('adminView').classList.contains('hidden'), false);
    assert.equal(el('errorView').classList.contains('hidden'), true);
    assert.equal(subscriptions, 2, 'Realtime must be re-established only after BFCache revalidation');
  } finally {
    w.close();
  }
}
