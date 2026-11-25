const { test } = require('node:test');
const assert = require('node:assert/strict');
const { businessContextDom } = require('../helpers/business-context-dom.cjs');

test('AC-001: local updates do not scan or rewrite existing navigation', async t => {
  const h = await businessContextDom({ rows: 1000 }); t.after(h.close);
  await h.context.configure(h.config()); await h.flush(); h.reset();
  const changes = h.document.getElementById('changes');
  for (let i = 0; i < 100; i++) {
    changes.textContent = String(i); await h.flush();
  }
  assert.equal(changes.textContent, '99');
  assert.equal(h.metrics.documentQueries, 0, 'text changes must not query the whole page');
  assert.equal(h.metrics.hrefWrites, 0, 'existing navigation must remain untouched');
  assert.equal(h.metrics.requests, 0, 'DOM mutations must not cause network reads');
});

test('AC-002: dynamically inserted roots and nested features receive the current gates', async t => {
  const h = await businessContextDom(); t.after(h.close);
  await h.context.configure(h.config()); await h.flush(); h.reset();
  const wrapper = h.document.createElement('section');
  wrapper.dataset.memberRequires = 'points';
  wrapper.innerHTML = `<div role="dialog">dialog</div><div data-benefit-kind="points">points</div>
    <div data-kind="event">events</div><div data-snapshot-kind="points">snapshot</div>
    <div data-member-requires="membership points">all</div><div data-member-any="points events">any</div>
    <a href="/points/?keep=yes">points link</a><a href="/event/">event link</a>
    <a data-business-switch="true" href="/admin/">switch</a><a href="/admin/workspace.html?business=shop-b">workspace</a>
    <a href="https://external.test/points/">external</a>`;
  h.document.getElementById('changes').append(wrapper);
  const rootLink = h.document.createElement('a'); rootLink.href = '/points/';
  h.document.getElementById('changes').append(rootLink); await h.flush();
  assert.equal(wrapper.dataset.memberAllowed, 'false'); assert.equal(wrapper.inert, true);
  for (const selector of ['[data-benefit-kind="points"]', '[data-snapshot-kind="points"]', '[data-member-requires]']) {
    assert.equal(wrapper.querySelector(selector).dataset.memberAllowed, 'false', selector);
  }
  for (const selector of ['[role="dialog"]', '[data-kind="event"]', '[data-member-any]']) {
    assert.equal(wrapper.querySelector(selector).dataset.memberAllowed, 'true', selector);
  }
  assert.equal(rootLink.href, 'https://fixture.test/points/?business=shop-a');
  assert.equal(rootLink.dataset.memberAllowed, 'false');
  const links = [...wrapper.querySelectorAll('a')];
  assert.equal(links[0].href, 'https://fixture.test/points/?keep=yes&business=shop-a');
  assert.equal(links[1].dataset.memberAllowed, 'true');
  assert.equal(links[2].href, 'https://fixture.test/admin/');
  assert.equal(links[3].href, 'https://fixture.test/admin/workspace.html?business=shop-b');
  assert.equal(links[4].href, 'https://external.test/points/');
  assert.equal(h.metrics.documentQueries, 0);
});

test('AC-003: revoke, restore and business switch update existing and newly inserted controls', async t => {
  const h = await businessContextDom({ rows: 1 }); t.after(h.close);
  const config = h.config(); await h.context.configure(config); await h.flush();
  const link = h.document.querySelector('nav a');
  assert.equal(link.dataset.memberAllowed, 'false');
  h.setFeatures({ points: true }); await h.context.refresh(config); await h.flush();
  assert.equal(link.dataset.memberAllowed, 'true');
  h.setFeatures({ booking: false, points: false }); await h.context.refresh(config); await h.flush();
  assert.equal(h.document.getElementById('bookingView').inert, true);
  assert.equal(link.dataset.memberAllowed, 'false');
  h.context.set('shop-b');
  assert.equal(link.href, 'https://fixture.test/points/?row=0&business=shop-b', 'switch navigation immediately to the selected merchant');
  assert.equal(link.dataset.memberAllowed, 'false');
  h.setFeatures({ booking: true, points: true }); await h.context.configure(h.config()); await h.flush();
  assert.equal(link.dataset.memberAllowed, 'true');
  assert.equal(h.document.getElementById('bookingView').inert, false);
  assert.equal(config.grantedFeatures.points, false, 'old merchant config must not be granted new merchant permissions');
});

test('AC-004: shared startup and unchanged refresh do not repeatedly rewrite brand or gates', async t => {
  const h = await businessContextDom({ rows: 1000 }); t.after(h.close); h.reset();
  await Promise.all(Array.from({ length: 100 }, () => h.context.configure(h.config()))); await h.flush();
  assert.equal(h.metrics.requests, 1);
  assert.ok(h.metrics.documentQueries < 100, 'shared startup applies features once rather than once per caller');
  h.reset(); await h.context.refresh(h.config()); await h.flush();
  assert.equal(h.metrics.requests, 1, 'refresh still obtains authoritative settings');
  assert.equal(h.metrics.observerBatches, 0, 'unchanged settings must not rewrite title or brand text');
  assert.ok(h.metrics.documentQueries < 3, 'unchanged grants do not rescan the page');
  h.setBrand('新品牌'); await h.context.refresh(h.config()); await h.flush();
  assert.equal(h.document.title, '新品牌｜預約');
  assert.equal(h.document.querySelector('[data-tenant-brand]').textContent, '新品牌 / 預約');
});

test('AC-005: overlapping mutation roots are visited once and detached nodes are ignored', async t => {
  const h = await businessContextDom(); t.after(h.close);
  await h.context.configure(h.config()); await h.flush(); h.reset();
  const parent = h.document.createElement('div'), child = h.document.createElement('div');
  const link = h.document.createElement('a'); link.href = '/points/';
  h.document.getElementById('changes').append(parent); parent.append(child); child.append(link);
  const detached = h.document.createElement('a'); detached.href = '/event/';
  parent.append(detached); detached.remove(); h.metrics.hrefWrites = 0;
  await h.flush();
  assert.equal(link.dataset.memberAllowed, 'false');
  assert.equal(detached.dataset.memberAllowed, undefined);
  assert.equal(detached.href, 'https://fixture.test/event/');
  assert.equal(h.metrics.hrefWrites, 1, 'nested roots must not repeat navigation writes');
  assert.equal(h.metrics.roots.has(child), false, 'the parent traversal already covers its child');
  assert.equal(h.metrics.documentQueries, 0);
  const batches = h.metrics.observerBatches; await h.flush();
  assert.equal(h.metrics.observerBatches, batches, 'observer must settle without a self-triggered loop');
});

test('AC-003: reused event booking guide recovers its gate after href removal and grant restoration', async t => {
  const h = await businessContextDom({ surface: 'event' }); t.after(h.close);
  const config = h.config(); await h.context.configure(config); await h.flush();
  const guide = h.document.createElement('a'); guide.href = '/booking/'; guide.textContent = '前往預約';
  h.document.getElementById('changes').append(guide); await h.flush();
  h.setFeatures({ booking: false }); await h.context.refresh(config); await h.flush();
  assert.equal(guide.inert, true);
  guide.removeAttribute('href'); guide.textContent = '目前未開放'; await h.flush();
  h.setFeatures({ booking: true }); await h.context.refresh(config); await h.flush();
  guide.href = '/booking/?source=event-ticket'; guide.textContent = '前往預約'; await h.flush();
  assert.equal(guide.dataset.memberAllowed, 'true', 'restored links must regain the current feature grant');
  assert.equal(guide.inert, false);
  assert.equal(guide.href, 'https://fixture.test/booking/?source=event-ticket&business=shop-a');
  h.reset(); guide.href = '/points/'; await h.flush();
  assert.equal(guide.dataset.memberAllowed, 'false', 'changing an existing route must apply its new feature gate');
  assert.equal(h.metrics.documentQueries, 0);
  const batches = h.metrics.observerBatches; await h.flush();
  assert.equal(h.metrics.observerBatches, batches, 'href repair must settle without rewriting itself');
});

test('AC-005: nodes moved into another document before observer delivery keep their new owner scope', async t => {
  const h = await businessContextDom(); t.after(h.close);
  await h.context.configure(h.config()); await h.flush();
  const frame = h.document.createElement('iframe'); h.document.body.append(frame); await h.flush();
  const moved = h.document.createElement('a'); moved.href = '/points/?business=shop-b';
  h.document.getElementById('changes').append(moved);
  frame.contentDocument.body.append(moved); await h.flush();
  assert.equal(moved.isConnected, true, 'an adopted node is still connected in its new document');
  assert.equal(moved.href, 'https://fixture.test/points/?business=shop-b');
  assert.equal(moved.dataset.memberAllowed, undefined);
});

test('AC-002: existing all, any and route override order is preserved on the same element', async t => {
  const h = await businessContextDom(); t.after(h.close);
  await h.context.configure(h.config()); await h.flush();
  const root = h.document.createElement('section');
  root.innerHTML = '<button data-member-requires="points" data-member-any="events">any wins</button><a href="/points/" data-member-any="events">route wins</a>';
  h.document.getElementById('changes').append(root); await h.flush();
  assert.equal(root.querySelector('button').dataset.memberAllowed, 'true');
  assert.equal(root.querySelector('a').dataset.memberAllowed, 'false');
});
