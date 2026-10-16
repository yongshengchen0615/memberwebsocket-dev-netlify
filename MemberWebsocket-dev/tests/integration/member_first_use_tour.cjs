const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'user-tour.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'user-tour.css'), 'utf8');
const memberApp = fs.readFileSync(path.join(root, 'member/app.js'), 'utf8');
const userQa = fs.readFileSync(path.join(root, 'user-test-control.js'), 'utf8');
const scenarioGraph = require(path.join(root, 'e2e-scenario-graph.js'));
const profile = (id = 'LINE_TEST_A') => ({ lineUserId: id, profileComplete: true, membershipRequired: false });
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

async function page({ surface = 'member', saved = {}, now = '2026-09-27T15:59:00Z', missing = '', testSession = false, query = '', cryptoImpl = webcrypto.subtle } = {}) {
  const html = fs.readFileSync(path.join(root, surface, 'index.html'), 'utf8');
  const suffix = query ? `?${String(query).replace(/^\?/, '')}` : '';
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: `https://example.test/${surface}/${suffix}` });
  const w = dom.window;
  await new Promise((resolve) => w.addEventListener('load', resolve, { once: true }));
  Object.defineProperty(w.crypto, 'subtle', { value: cryptoImpl });
  w.TextEncoder = TextEncoder;
  w.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  };
  if (testSession) w.TestModeClient = { getSessionToken: () => 'test-session' };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const view = w.document.querySelector('main[data-user-tour]');
  view.classList.remove('hidden');
  if (missing) w.document.querySelector(missing)?.remove();
  for (const [key, value] of Object.entries(saved)) w.localStorage.setItem(key, value);
  w.eval(script);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const ready = async (id = 'LINE_TEST_A') => {
    const eventName = surface === 'member' ? 'member-profile-ready' : 'user-tour:ready';
    w.dispatchEvent(new w.CustomEvent(eventName, { detail: { surface, profile: profile(id) } }));
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(id))).toString('hex');
    const deadline = Date.now()+3000;
    while (!w.document.getElementById('memberTourDialog').dataset.storageKey?.endsWith(hash)) {
      if(Date.now()>deadline)throw new Error('Tutorial identity initialization timed out');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await tick();
  };
  return { dom, w, ready, dialog: w.document.getElementById('memberTourDialog') };
}

test('permanent opt-out survives another day and manual replay, isolated by member', async () => {
 const first=await page();await first.ready();assert.equal(first.dialog.classList.contains('hidden'),false);
 assert.equal(first.w.document.getElementById('memberTourSkip').textContent,'不再顯示');
 first.w.document.getElementById('memberTourSkip').click();assert.equal(first.w.document.getElementById('app').inert,false);
 const saved=Object.fromEntries(Object.entries(first.w.localStorage));assert.equal(JSON.parse(Object.values(saved)[0]).disabled,true);first.dom.window.close();
 const tomorrow=await page({saved,now:'2026-10-03T16:00:00Z'});await tomorrow.ready();assert.equal(tomorrow.dialog.classList.contains('hidden'),true);
 tomorrow.w.document.getElementById('openMemberTour').click();assert.equal(tomorrow.dialog.classList.contains('hidden'),false);
 for(let i=0;i<8&&!tomorrow.dialog.classList.contains('hidden');i++)tomorrow.w.document.getElementById('memberTourNext').click();
 assert.equal(JSON.parse(Object.values(Object.fromEntries(Object.entries(tomorrow.w.localStorage)))[0]).disabled,true);
 await tomorrow.ready('LINE_TEST_B');assert.equal(tomorrow.dialog.classList.contains('hidden'),false);
 tomorrow.dialog.dispatchEvent(new tomorrow.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(tomorrow.w.document.getElementById('app').inert,false);tomorrow.dom.window.close();
});

test('only an explicit current-format daily skip suppresses auto-start', async () => {
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('LINE_TEST_A'))).toString('hex');
  const key = `member-tour:${hash}`;
  const completed = await page({ saved: { [key]: JSON.stringify({ version: 1, outcome: 'complete', completedAt: '2026-09-27T15:59:00Z' }) } });
  await completed.ready();
  assert.equal(completed.dialog.classList.contains('hidden'), false);
  completed.dom.window.close();

  const ambiguousOldSkip = { [key]: JSON.stringify({ version: 1, outcome: 'skip', completedAt: '2026-09-27T15:59:00Z' }) };
  const legacy = await page({ saved: ambiguousOldSkip });
  await legacy.ready();
  assert.equal(legacy.dialog.classList.contains('hidden'), false);
  legacy.dom.window.close();

  const explicitSkip = { [key]: JSON.stringify({ outcome: 'skip', source: 'explicit', skippedAt: '2026-09-27T15:59:00Z' }) };
  const today = await page({ saved: explicitSkip });
  await today.ready();
  assert.equal(today.dialog.classList.contains('hidden'), true);
  today.dom.window.close();

  const tomorrow = await page({ saved: explicitSkip, now: '2026-09-27T16:00:00Z' });
  await tomorrow.ready();
  assert.equal(tomorrow.dialog.classList.contains('hidden'), false);
  tomorrow.dom.window.close();
});

test('late identity digest cannot open a departed or detached tutorial page',async()=>{
  for(const detached of [false,true]) {
    let release;
    const cryptoImpl={digest(...args){const actual=webcrypto.subtle.digest(...args);return new Promise(resolve=>{release=async()=>resolve(await actual);});}};
    const current=await page({cryptoImpl});const {w,dialog}=current;
    w.dispatchEvent(new w.CustomEvent('member-profile-ready',{detail:{profile:profile()}}));
    assert.equal(typeof release,'function');
    if(detached)w.close();else w.dispatchEvent(new w.PageTransitionEvent('pagehide'));
    await release();await tick();
    assert.equal(dialog.classList.contains('hidden'),true);
    assert.equal(dialog.dataset.storageKey,undefined);
    if(!detached) {assert.notEqual(w.document.getElementById('app').inert,true);w.close();}
  }
});

test('spotlight dims only outside the selected UI and moves the dialog away from its target', async () => {
  assert.match(styles, /\.member-tour-overlay\s*\{[^}]*background:\s*transparent/);
  assert.match(styles, /\.member-tour-mask\s*\{[^}]*background:\s*var\(--theme-overlay,\s*rgba\(7,\s*18,\s*14,\s*\.48\)\)/);
  assert.doesNotMatch(styles, /200vmax/);
  assert.match(styles, /#memberTourSkip[^{]*\{[^}]*background:\s*transparent/);
  const { dom, w, ready, dialog } = await page();
  const target = w.document.getElementById('memberPass');
  let top = 600;
  target.getBoundingClientRect = () => ({ left: 700, right: 900, top, bottom: top + 100 });
  dialog.getBoundingClientRect = () => ({ left: 614, right: 1004, height: 280 });
  await ready();
  for (let attempt = 0; attempt < 8 && !dialog.classList.contains('member-tour-dialog-top'); attempt += 1) await tick();
  assert.equal(dialog.classList.contains('member-tour-dialog-top'), true);
  assert.equal(w.document.getElementById('memberTourFocus').style.left, '695px');
  const masks = Object.fromEntries(
    Array.from(w.document.querySelectorAll('[data-member-tour-mask]'))
      .map((mask) => [mask.dataset.memberTourMask, mask])
  );
  assert.deepEqual(Object.keys(masks).sort(), ['bottom', 'left', 'right', 'top']);
  assert.equal(masks.top.style.height, '585px');
  assert.equal(masks.bottom.style.top, '715px');
  assert.equal(masks.left.style.width, '685px');
  assert.equal(masks.left.style.height, '130px');
  assert.equal(masks.right.style.left, '915px');
  assert.equal(masks.right.style.height, '130px');
  top = 60;
  w.dispatchEvent(new w.Event('scroll'));
  await tick();
  assert.equal(dialog.classList.contains('member-tour-dialog-top'), false);
  assert.equal(masks.top.style.height, '45px');
  assert.equal(masks.bottom.style.top, '175px');
  dom.window.close();
});

test('tour advances when its current anchor disappears and releases the page if no anchors remain', async () => {
  const { dom, w, ready, dialog } = await page();
  try {
    await ready();
    w.document.querySelector('#memberPass').remove();
    await tick();
    assert.match(dialog.textContent, /查看升等進度/);
    for (const selector of ['#membershipProgress', '.profile-details', '#memberFeatureLinks']) {
      w.document.querySelector(selector)?.remove();
    }
    await tick();
    assert.equal(dialog.classList.contains('hidden'), true);
    assert.equal(w.document.getElementById('app').inert, false);
    assert.equal(w.localStorage.length, 0);
  } finally { dom.window.close(); }
});

test('tour restores interaction when its view becomes hidden during a realtime refresh', async () => {
  const { dom, w, ready, dialog } = await page();
  try {
    await ready();
    w.document.querySelector('main[data-user-tour]').classList.add('hidden');
    await tick();
    assert.equal(dialog.classList.contains('hidden'), true);
    assert.equal(w.document.getElementById('app').inert, false);
  } finally { dom.window.close(); }
});

test('tour batches scroll geometry and cancels pending layout work on close/pagehide', async () => {
  const { dom, w, ready, dialog } = await page();
  try {
    await ready();
    const callbacks = new Map();
    let frames = 0;
    w.requestAnimationFrame = (callback) => { callbacks.set(++frames, callback); return frames; };
    w.cancelAnimationFrame = (id) => callbacks.delete(id);
    for (let index = 0; index < 20; index++) w.dispatchEvent(new w.Event('scroll'));
    assert.equal(callbacks.size, 1);
    w.dispatchEvent(new w.PageTransitionEvent('pagehide'));
    assert.equal(callbacks.size, 0);
    assert.equal(dialog.classList.contains('hidden'), true);
    assert.equal(w.document.getElementById('app').inert, false);
    assert.equal(w.localStorage.length, 0);
  } finally { dom.window.close(); }
});

test('account isolation, missing anchor, keyboard escape and focus return', async () => {
  const { dom, w, ready, dialog } = await page({ missing: '#membershipProgress' });
  await ready();
  w.document.getElementById('memberTourNext').click();
  assert.match(dialog.textContent, /確認個人資料/);
  w.document.getElementById('memberTourOverlay').click();
  assert.equal(dialog.classList.contains('hidden'), false);
  assert.equal(w.localStorage.length, 0);
  const escape = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  dialog.dispatchEvent(escape);
  assert.equal(dialog.classList.contains('hidden'), true);
  assert.equal(w.localStorage.length, 0);
  assert.equal(w.document.activeElement.id, 'openMemberTour');
  await ready('LINE_TEST_B');
  assert.equal(dialog.classList.contains('hidden'), false);
  assert.equal(Object.keys(w.localStorage).length, 0);
  const backwardsTab = new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  dialog.dispatchEvent(backwardsTab);
  assert.equal(w.document.activeElement.id, 'memberTourNext');
  w.document.getElementById('memberTourSkip').click();
  assert.equal(Object.keys(w.localStorage).length, 1);
  dom.window.close();
});

test('tour keeps waiting until the member view becomes visible, even after a slow login transition', async () => {
  const { dom, w, ready, dialog } = await page();
  w.document.querySelector('main[data-user-tour]').classList.add('hidden');
  await ready();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(dialog.classList.contains('hidden'), true);
  w.document.querySelector('main[data-user-tour]').classList.remove('hidden');
  await tick();
  assert.equal(dialog.classList.contains('hidden'), false);
  dom.window.close();
});

test('member onboarding tour starts before profile completion and hands off to the member-card tour', async () => {
  const current = await page({ surface: 'member' });
  const { w, dialog } = current;
  const memberView = w.document.querySelector('main[data-user-tour]');
  const setupView = w.document.getElementById('profileSetupView');

  memberView.classList.add('hidden');
  setupView.classList.remove('hidden');
  w.dispatchEvent(new w.CustomEvent('member-profile-ready', {
    detail: { profile: { lineUserId: 'LINE_TEST_A', profileComplete: false, membershipRequired: true } }
  }));
  await tick();

  assert.equal(dialog.classList.contains('hidden'), false);
  assert.match(dialog.textContent, /先完成會員資料/);
  assert.equal(w.document.getElementById('memberTourProgress').textContent, '使用教學 1 / 7');
  w.document.getElementById('memberTourNext').click();
  assert.match(dialog.textContent, /填寫姓氏/);
  w.document.getElementById('memberTourSkip').click();

  const setupKeys = Object.keys(w.localStorage);
  assert.equal(setupKeys.length, 1);
  assert.match(setupKeys[0], /^member-setup-tour:/);

  setupView.classList.add('hidden');
  memberView.classList.remove('hidden');
  w.dispatchEvent(new w.CustomEvent('member-profile-ready', {
    detail: { profile: profile('LINE_TEST_A') }
  }));
  await tick();

  assert.equal(dialog.classList.contains('hidden'), false);
  assert.match(dialog.textContent, /這是你的會員卡/);
  assert.equal(Object.keys(w.localStorage).length, 1, 'setup daily skip must not suppress the member-card tour');
  current.dom.window.close();
});

test('test-account onboarding uses the same server-resolved member identity as real accounts', async () => {
  const current = await page({ surface: 'member', testSession: true });
  const { w, dialog } = current;
  w.document.querySelector('main[data-user-tour]').classList.add('hidden');
  w.document.getElementById('profileSetupView').classList.remove('hidden');

  w.dispatchEvent(new w.CustomEvent('member-profile-ready', {
    detail: { profile: { lineUserId: 'LINE_TEST_A', profileComplete: false, membershipRequired: true } }
  }));
  await tick();

  assert.equal(dialog.classList.contains('hidden'), false);
  assert.match(dialog.textContent, /先完成會員資料/);
  w.document.getElementById('memberTourSkip').click();
  const keys = Object.keys(w.localStorage);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^member-setup-tour:/);
  assert.doesNotMatch(keys[0], /LINE_TEST_A|test-session/);
  current.dom.window.close();
});

test('member app announces tour readiness after setup and member views are shown', () => {
  assert.match(memberApp, /setView\('profileSetup'\);\s*announceTourReady\(state\.profile\);\s*return;/);
  assert.match(memberApp, /setView\('member'\);\s*announceTourReady\(state\.profile\);/);
  assert.match(memberApp, /renderProfile\(profile\);\s*setView\('member'\);\s*announceTourReady\(profile\);/);
  const renderProfileBody = memberApp.match(/function renderProfile\(profile\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.doesNotMatch(renderProfileBody, /member-profile-ready/);
});

test('refresh during the tour restarts safely, and absent anchors leave the page usable', async () => {
  const first = await page();
  await first.ready();
  first.w.document.getElementById('memberTourNext').click();
  assert.equal(first.w.localStorage.length, 0);
  first.dom.window.close();

  const refreshed = await page();
  await refreshed.ready();
  assert.match(refreshed.dialog.textContent, /這是你的會員卡/);
  refreshed.dom.window.close();

  const noAnchors = await page();
  for (const selector of ['#memberPass', '#membershipProgress', '.profile-details', '#memberFeatureLinks']) {
    noAnchors.w.document.querySelector(selector).remove();
  }
  await noAnchors.ready();
  assert.equal(noAnchors.dialog.classList.contains('hidden'), true);
  assert.notEqual(noAnchors.w.document.getElementById('app').inert, true);
  assert.equal(noAnchors.w.localStorage.length, 0);
  noAnchors.dom.window.close();
});

test('every member client has a permanent opt-out and manual replay button', async () => {
  let saved = {};
  const titles = {
    member: '這是你的會員卡',
    points: '查看會員階級',
    event: '確認會員資格',
    calendar: '確認會員階級',
    booking: '確認會員階級',
  };
  for (const surface of Object.keys(titles)) {
    const current = await page({ surface, saved });
    await current.ready();
    assert.equal(current.dialog.classList.contains('hidden'), false, surface);
    assert.match(current.dialog.textContent, new RegExp(titles[surface]));
    assert.equal(current.w.document.getElementById('memberTourSkip').textContent, '不再顯示');
    assert.equal(current.w.document.getElementById('openMemberTour').getAttribute('aria-controls'), 'memberTourDialog');
    current.w.document.getElementById('memberTourSkip').click();
    assert.equal(current.dialog.classList.contains('hidden'), true);
    current.w.document.getElementById('openMemberTour').click();
    assert.equal(current.dialog.classList.contains('hidden'), false, `${surface} replay`);
    current.w.document.getElementById('memberTourSkip').click();
    saved = Object.fromEntries(Object.entries(current.w.localStorage));
    current.dom.window.close();
  }
  assert.equal(Object.keys(saved).length, 5);
  const sameDay = await page({ surface: 'booking', saved });
  await sameDay.ready();
  assert.equal(sameDay.dialog.classList.contains('hidden'), true);
  sameDay.dom.window.close();
  const nextDay = await page({ surface: 'booking', saved, now: '2026-09-27T16:00:00Z' });
  await nextDay.ready();
  assert.equal(nextDay.dialog.classList.contains('hidden'), true);
  nextDay.dom.window.close();
});

test('empty event data skips absent ticket targets, and an existing dialog is not covered', async () => {
  const current = await page({ surface: 'event' });
  current.w.document.getElementById('emptyView').classList.remove('hidden');
  await current.ready();
  current.w.document.getElementById('memberTourNext').click();
  current.w.document.getElementById('memberTourNext').click();
  assert.match(current.dialog.textContent, /尚無開放活動/);
  assert.equal(current.w.document.getElementById('memberTourProgress').textContent, '使用教學 3 / 3');
  current.w.document.getElementById('memberTourSkip').click();
  current.dom.window.close();

  const blocked = await page({ surface: 'event' });
  blocked.w.document.getElementById('ticketModal').classList.remove('hidden');
  await blocked.ready();
  assert.equal(blocked.dialog.classList.contains('hidden'), true);
  blocked.w.document.getElementById('ticketModal').classList.add('hidden');
  await tick();
  assert.equal(blocked.dialog.classList.contains('hidden'), false);
  blocked.dom.window.close();
});

test('test accounts auto-start the same tutorial as real members', async () => {
  const current = await page({ surface: 'booking', testSession: true });
  await current.ready();
  assert.equal(current.dialog.classList.contains('hidden'), false);
  assert.match(current.dialog.textContent, /確認會員階級/);
  current.dom.window.close();
});

test('paired E2E always receives the tutorial so the runner can validate and dismiss it without persisting a skip', async () => {
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('LINE_TEST_A'))).toString('hex');
  const key = `user-tour:booking:${hash}`;
  const current = await page({
    surface: 'booking',
    testSession: true,
    query: 'qaPair=run-1&e2eParticipant=1',
    saved: {
      [key]: JSON.stringify({ outcome: 'skip', source: 'explicit', skippedAt: '2026-09-27T15:59:00Z' })
    }
  });
  await current.ready();
  assert.equal(current.dialog.classList.contains('hidden'), false);
  current.dialog.dispatchEvent(new current.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  assert.equal(current.dialog.classList.contains('hidden'), true);
  assert.equal(JSON.parse(current.w.localStorage.getItem(key)).source, 'explicit');
  current.dom.window.close();
});

test('paired E2E tutorial stays functional when a hidden tab stops animation frames', async () => {
  const current = await page({
    surface: 'event',
    testSession: true,
    query: 'qaPair=hidden-tab&e2eParticipant=1'
  });
  const { w, dialog } = current;
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'hidden' });
  w.requestAnimationFrame = () => 1;
  w.cancelAnimationFrame = () => {};
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.id === 'memberTourDialog'
      ? { left: 10, right: 400, top: 600, bottom: 880, width: 390, height: 280 }
      : { left: 100, right: 300, top: 160, bottom: 240, width: 200, height: 80 };
  };

  await current.ready();
  assert.equal(dialog.classList.contains('hidden'), false, 'auto-start must not depend on requestAnimationFrame');
  const focus = w.document.getElementById('memberTourFocus');
  assert.equal(focus.classList.contains('hidden'), false, 'spotlight geometry must be available without requestAnimationFrame');
  assert.equal(focus.style.left, '95px');
  assert.equal(focus.style.width, '210px');

  dialog.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(w.document.getElementById('app').inert, false);
  current.dom.window.close();
});

test('the unified E2E runner completes the tutorial journey on all five client surfaces and restores daily state', async () => {
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('LINE_TEST_A'))).toString('hex');
  const priorSkip = { [`user-tour:booking:${hash}`]: JSON.stringify({ outcome: 'skip', source: 'explicit', skippedAt: '2026-09-27T15:59:00Z' }) };
  const fixtures = ['member', 'points', 'event', 'calendar', 'booking'].map((surface) => ({ surface, saved: {} }));
  fixtures.push({ surface: 'booking', saved: priorSkip });
  for (const { surface, saved } of fixtures) {
    const current = await page({ surface, saved, query: 'qaPair=tour-e2e' });
    const { w, dialog } = current;
    w.history.replaceState(null, '', `https://example.test/MemberWebsocket-dev/${surface}/?qaPair=tour-e2e`);
    const style = w.document.createElement('style');
    style.textContent = '.member-tour-overlay { background: transparent; } .member-tour-mask { background: rgba(7, 18, 14, .48); }';
    w.document.head.append(style);
    w.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.id === 'memberTourDialog'
        ? { left: 10, right: 400, top: 600, bottom: 880, width: 390, height: 280 }
        : { left: 100, right: 300, top: 160, bottom: 240, width: 200, height: 80 };
    };
    w.MemberE2EScenarioGraph = scenarioGraph;
    const exposed = userQa.replace(/\}\)\(\);\s*$/, 'globalThis.__tourQa = { tourAutoStartCase, tourJourneyCase, buildCases };})();');
    assert.notEqual(exposed, userQa);
    w.eval(exposed);
    for (const suite of ['quick', 'full']) {
      const keys = Array.from(w.__tourQa.buildCases(suite), ({ key }) => key);
      assert.ok(keys.indexOf('COMMON_TOUR_AUTOSTART') >= 0, `${surface} ${suite}`);
      assert.ok(keys.indexOf('COMMON_TOUR_AUTOSTART') < keys.indexOf('COMMON_TOUR_JOURNEY'), `${surface} ${suite}`);
      assert.ok(keys.indexOf('COMMON_TOUR_JOURNEY') < keys.indexOf('COMMON_CONFIG'), `${surface} ${suite}`);
    }
    await current.ready();
    const auto = await w.__tourQa.tourAutoStartCase();
    assert.equal(auto.status, 'passed', `${surface}: ${auto.message}`);
    assert.equal(dialog.classList.contains('hidden'), true);
    const foreignKey = surface === 'member' ? 'member-tour:other-participant' : `user-tour:${surface}:other-participant`;
    w.localStorage.setItem(foreignKey,'before-concurrent-write');
    w.document.getElementById('memberTourSkip').addEventListener('click',()=>w.localStorage.setItem(foreignKey,'concurrent-write'));
    const journey = await w.__tourQa.tourJourneyCase();
    assert.equal(journey.status, 'passed', `${surface}: ${journey.message}`);
    assert.ok(journey.actual.steps.length >= 2, surface);
    assert.equal(journey.actual.stateRestored, true, surface);
    assert.equal(w.localStorage.getItem(foreignKey),'concurrent-write',surface+' must preserve another participant state');
    w.localStorage.removeItem(foreignKey);
    assert.deepEqual(Object.fromEntries(Object.entries(w.localStorage)), saved, surface);
    current.dom.window.close();
  }
});
