'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sourceFile = 'MemberWebsocket-dev/admin/booking-admin-ux.js';

function harness() {
  const elements = new Map();
  const listeners = new Map();
  const pending = [];
  const confirmations = [];
  let allow = true;
  const document = {
    body: {
      append(node) { elements.set(node.id, node); },
      setAttribute() {},
      removeAttribute() {},
    },
    getElementById(id) { return elements.get(id) || null; },
    createElement(tag) {
      return { tag, id: '', hidden: true, className: '', textContent: '',
        setAttribute() {}, removeAttribute() {} };
    },
    addEventListener(type, handler, capture) {
      listeners.set(type + ':' + Boolean(capture), handler);
    },
  };
  const win = {
    confirm(message) { confirmations.push(message); return allow; },
    fetch(...args) { return new Promise((resolve, reject) => pending.push({ args, resolve, reject })); },
  };
  vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), { document, window: win, Promise, JSON, String, Set });
  return { win, elements, listeners, pending, confirmations, setAllow(value) { allow = value; } };
}

function actionEvent(target) {
  return { target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; } };
}

test('AC-001: booking mutation displays loading through backend response and releases on failure', async () => {
  const h = harness();
  const request = h.win.fetch('/functions/v1/booking-api', {
    method: 'POST', body: JSON.stringify({ clientType: 'admin', action: 'admin.booking.status.update' }),
  });
  assert.equal(h.elements.get('adminBookingPendingOverlay')?.hidden, false);
  assert.equal(h.pending.length, 1);
  h.pending[0].reject(new Error('network unavailable'));
  await assert.rejects(request, /network unavailable/);
  assert.equal(h.elements.get('adminBookingPendingOverlay')?.hidden, true);
});

test('AC-002: parallel writes keep loading until last backend response; reads and background badge updates do not flash', async () => {
  const h = harness();
  const send = action => h.win.fetch('/functions/v1/booking-admin-api', {
    method: 'POST', body: JSON.stringify({ clientType: 'admin', action }),
  });
  const read = send('admin.booking.bootstrap');
  assert.equal(h.elements.get('adminBookingPendingOverlay'), undefined);
  h.pending[0].resolve({ ok: true }); await read;
  const a = send('admin.booking.settings.save');
  const b = send('admin.booking.messages.save');
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden, false);
  h.pending[1].resolve({ ok: true }); await a;
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden, false);
  h.pending[2].resolve({ ok: true }); await b;
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden, true);
  const badge = send('admin.booking.notifications.read');
  h.pending[3].resolve({ ok: true }); await badge;
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden, true);
});

test('AC-003: cancelling direct booking action stops delivery to original click handler', () => {
  const h = harness(); h.setAllow(false);
  const button = {
    disabled: false, dataset: { bookingAdminAction: '確認預約' },
    closest(selector) {
      if (selector === '[data-booking-admin-action]') return this;
      if (selector === '[data-booking-id]') return { dataset: {
        bookingMemberName: '測試會員', bookingDate: '2026-11-23',
        bookingStartTime: '10:00', bookingEndTime: '11:00' } };
      return null;
    },
  };
  const event = actionEvent({ closest: selector => selector === '[data-booking-admin-action]' ? button : null });
  h.listeners.get('click:true')(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.match(h.confirmations[0], /2026-11-23/);
  assert.match(h.confirmations[0], /確認預約/);
});

test('AC-004: final booking form submit needs second confirmation, read-only controls do not', () => {
  const h = harness(); h.setAllow(false);
  const form = {
    id: 'bookingAdminSettingsForm',
    matches: name => name === 'form',
    getAttribute: () => null,
    querySelector: selector => selector === '[type="submit"]' ? { disabled: false } : null,
    closest: () => null,
  };
  const cancelled = actionEvent(form);
  h.listeners.get('submit:true')(cancelled);
  assert.equal(cancelled.prevented, true);
  assert.equal(cancelled.stopped, true);
  h.setAllow(true);
  const accepted = actionEvent(form);
  h.listeners.get('submit:true')(accepted);
  assert.equal(accepted.prevented, false);
  assert.match(h.confirmations[0], /預約/);
  const readOnly = actionEvent({ closest: () => null });
  h.listeners.get('click:true')(readOnly);
  assert.equal(h.confirmations.length, 2);
});

test('AC-005: no duplicate confirmation for flows already using native explicit confirmation', () => {
  const h = harness();
  const excluded = ['approve-cancellation', 'reject-cancellation', 'copy-booking', '刪除項目類型'];
  for (const action of excluded) {
    const button = { disabled: false, dataset: { bookingAdminAction: action } };
    const event = actionEvent({ closest: selector => selector === '[data-booking-admin-action]' ? button : null });
    h.listeners.get('click:true')(event);
    assert.equal(event.prevented, false);
  }
  assert.equal(h.confirmations.length, 0);
});

test('AC-006: non-booking writes share the admin Loading while background reads remain unblocked',async()=>{
  const h=harness();
  const send=(action,clientType='admin',url='/functions/v1/member-api')=>
    h.win.fetch(url,{method:'POST',body:JSON.stringify({clientType,action})});
  const read=send('admin.members.presence.list');
  assert.equal(h.elements.get('adminBookingPendingOverlay'),undefined);
  h.pending[0].resolve({ok:true});await read;
  const save=send('admin.event-tickets.save');
  assert.equal(h.elements.get('adminBookingPendingOverlay')?.hidden,false);
  const event=actionEvent({closest:()=>null});
  h.listeners.get('click:true')(event);
  assert.equal(event.prevented,true);
  assert.equal(event.stopped,true);
  h.pending[1].resolve({ok:true});await save;
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden,true);
  const platform=send('platform.line.save','platform','/functions/v1/platform-api');
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden,false);
  h.pending[2].resolve({ok:true});await platform;
  assert.equal(h.elements.get('adminBookingPendingOverlay').hidden,true);
});
