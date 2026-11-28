const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../booking/app.js'), 'utf8');
function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'member booking source section is available: ' + start);
  return app.slice(from, to);
}

function createHarness({ slotAvailable = true, deferredSlot = null } = {}) {
  const nodes = [];
  class FakeClassList {
    constructor(initial = []) { this.values = new Set(initial); }
    contains(value) { return this.values.has(value); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    toggle(value, enabled) {
      if (enabled === undefined) enabled = !this.contains(value);
      enabled ? this.add(value) : this.remove(value);
    }
  }
  function element(initial = []) {
    return {
      classList: new FakeClassList(initial), disabled: false, textContent: '',
      addEventListener() {}, setAttribute() {}, focus() {},
      appendChild(child) { this.children ||= []; this.children.push(child); },
      replaceChildren() { this.children = []; },
      querySelectorAll() { return this.children || []; },
    };
  }
  const state = {
    config: {}, idToken: 'qa-token', refreshSequence: 0, slotRequestSequence: 0,
    selections: [{ serviceId: 'service-1' }], selectedSlot: {
      startTime: '15:30', endTime: '17:50',
      startAt: '2026-11-29T15:30:00+08:00', endAt: '2026-11-29T17:50:00+08:00',
    }, data: { today: '2026-11-28', settings: {}, services: [], bookings: [] },
    profile: {}, editing: null, submitting: false, loadingSlots: false,
  };
  const els = {
    bookingDate: { value: '2026-11-29' },
    slotGrid: element(),
    slotHint: element(),
    submitBookingButton: element(),
    bookingConfirmModal: element(),
    bookingBenefitModal: element(['hidden']),
    confirmBookingButton: element(),
    closeBookingBenefitButton: element(),
  };
  const messages = [];
  const requests = [];
  const window = {
    location: { search: '' },
    BookingSystem: {
      async request(_config, _kind, _idToken, action, payload) {
        requests.push({ action, payload });
        if (action === 'user.booking.bootstrap') return {
          today: '2026-11-28', services: [], settings: {}, bookings: [],
        };
        if (action === 'user.booking.slots') {
          if (deferredSlot) await deferredSlot.promise;
          return { slots: [{
            startTime: '15:30', endTime: '17:50',
            startAt: '2026-11-29T15:30:00+08:00',
            endAt: '2026-11-29T17:50:00+08:00',
            available: slotAvailable,
          }], totalDurationMinutes: 140 };
        }
        throw new Error('Unexpected action: ' + action);
      },
      async memberProfile() { return {}; },
      setBookingNotice() {},
      formatDate(value) { return value; },
    },
    BookingGroupUI: { missingItemsHint() { return ''; } },
    BookingBenefits: { invalidate() {}, syncNow() {} },
    MemberMonthlyTierBenefits: { bind() {} },
    dispatchEvent() {},
  };
  const document = {
    createElement() { const node = element(); nodes.push(node); return node; },
    querySelector() { return null; },
  };
  const noop = () => {};
  const context = {
    window, document, state, els, URLSearchParams, CustomEvent: class CustomEvent {},
    schedulePriceRefresh: noop, syncServerClock: noop, pruneSelections: noop,
    renderMemberProfile: noop, renderBookingRestriction: noop, renderSettings: noop,
    renderServices: noop, renderBookings: noop, renderSlots: undefined,
    applySelectionConstraints() {
      state.selectedSlot = null;
      els.slotGrid.replaceChildren();
      els.submitBookingButton.disabled = true;
    },
    userServices() { return []; }, selectedItems() {
      return [{ serviceId: 'service-1', quantity: 1 }];
    },
    bookingRestricted() { return false; }, globalMaximumDate() { return ''; },
    totalDurationMinutes() { return 140; }, storeServiceMinutes() { return 10; },
    currentServerTimeMs() { return Date.now(); }, reminderError() { return ''; },
    clearFormMessage: noop, clearConfirmMessage: noop,
    showFormMessage: noop, updateBenefitSubmitButtons: noop,
    showConfirmMessage(message) { messages.push(message); },
    AsyncActionFeedback: null,
  };
  const functions = vm.runInNewContext([
    section('  async function refresh(', '\n  function pruneSelections('),
    section('  async function loadSlots(', '\n  function renderSlots('),
    section('  function renderSlots(', '\n  function selectSlot('),
    section('  function selectSlot(', '\n  function reminderPreference('),
    section('  function openBenefitStep(', '\n  function closeBenefitStep('),
    '({refresh, loadSlots, renderSlots, selectSlot, openBenefitStep})',
  ].join('\n'), context);
  return { state, els, messages, requests, functions };
}

test('AC-001: a background booking refresh retains an unchanged available slot on the confirmation step', async () => {
  const h = createHarness();
  assert.equal(await h.functions.refresh(false), true);
  assert.equal(h.state.selectedSlot?.startTime, '15:30');
  assert.equal(h.els.slotGrid.children.filter((node) => node.classList.contains('selected')).length, 1);
  assert.equal(h.els.submitBookingButton.disabled, false);
  await h.functions.openBenefitStep();
  assert.equal(h.els.bookingConfirmModal.classList.contains('hidden'), true);
  assert.equal(h.els.bookingBenefitModal.classList.contains('hidden'), false);
  assert.deepEqual(h.messages, []);
});

test('AC-002: an actually unavailable slot is not restored after background refresh', async () => {
  const h = createHarness({ slotAvailable: false });
  await h.functions.refresh(false);
  assert.equal(h.state.selectedSlot, null);
  await h.functions.openBenefitStep();
  assert.equal(h.els.bookingConfirmModal.classList.contains('hidden'), false);
  assert.equal(h.els.bookingBenefitModal.classList.contains('hidden'), true);
  assert.equal(h.messages.length, 1);
});

test('AC-003: tapping next while automatic slot revalidation is pending waits for its latest result', async () => {
  const deferredSlot = Promise.withResolvers();
  const h = createHarness({ deferredSlot });
  const refreshPromise = h.functions.refresh(false);
  for (let i = 0; i < 10 && !h.state.loadingSlots; i++) await Promise.resolve();
  assert.equal(h.state.loadingSlots, true);
  const nextPromise = h.functions.openBenefitStep();
  assert.equal(h.els.bookingBenefitModal.classList.contains('hidden'), true);
  deferredSlot.resolve();
  assert.equal(await refreshPromise, true);
  await nextPromise;
  assert.equal(h.state.selectedSlot?.startTime, '15:30');
  assert.equal(h.els.bookingBenefitModal.classList.contains('hidden'), false);
  assert.deepEqual(h.messages, []);
});

test('AC-004: an outdated slot candidate never restores for a different date or selection', async () => {
  const itemsKey = JSON.stringify([{ serviceId: 'service-1', quantity: 1 }]);
  for (const restoration of [
    { bookingDate: '2026-11-30', itemsKey, startTime: '15:30' },
    { bookingDate: '2026-11-29', itemsKey: '[]', startTime: '15:30' },
  ]) {
    const h = createHarness();
    h.state.selectedSlot = null;
    h.state.slotRestoration = restoration;
    await h.functions.loadSlots(false);
    assert.equal(h.state.selectedSlot, null, 'do not carry over a time from another form selection');
    assert.equal(h.els.slotGrid.children.filter((node) => node.classList.contains('selected')).length, 0);
  }
});
