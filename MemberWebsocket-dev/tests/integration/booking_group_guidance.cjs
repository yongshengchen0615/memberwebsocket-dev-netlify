const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'booking/group-booking.js'), 'utf8');

async function setup() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="appointmentPanel"><div class="booking-selection-modal-body">
      <fieldset class="service-picker-fieldset"><legend>可選預約項目</legend><div id="servicePicker"></div></fieldset>
      <fieldset class="selected-service-fieldset"><legend>目前選擇</legend><div id="selectedServiceList"></div></fieldset>
      <div id="selectionSummary" class="hidden"></div>
      <div id="formMessage" class="hidden"></div>
      <input id="bookingDate" value="">
    </div></div>
  </body></html>`, {
    url: 'https://booking.example.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const scrolls = [];
  w.HTMLElement.prototype.scrollIntoView = function (options) {
    scrolls.push({ element: this, options });
  };
  w.matchMedia = () => ({ matches: false });
  w.BookingServiceTypeColor = { slot: () => 0 };
  w.crypto.randomUUID = () => '50000000-0000-4000-8000-000000000001';
  w.BookingSystem = {
    request: async () => ({
      settings: {}, bookings: [],
      services: [{
        serviceId: '20000000-0000-4000-8000-000000000001',
        title: '測試服務', durationMinutes: 40, priceAmount: 800, isActive: true,
      }],
    }),
    clientError: (code, message) => Object.assign(new Error(message), { code }),
  };
  w.fetch = async () => new Response(JSON.stringify({
    ok: true,
    data: {
      settings: { maxPartySize: 3, primaryTechnicianId: 'tech-1' },
      technicians: [{ technicianId: 'tech-1', name: '主要技師', isActive: true }],
      bookingGroups: {},
    },
  }), { status: 200 });

  w.eval(source);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  await w.BookingSystem.request(
    { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' },
    'member', 'fixture-token', 'user.booking.bootstrap',
  );
  const party = w.document.getElementById('bookingPartySize');
  party.value = '2';
  party.dispatchEvent(new w.Event('change', { bubbles: true }));
  return {
    dom, w, scrolls,
    card: (index) => w.document.querySelector(`.participant-card[data-participant-index="${index}"]`),
    warning: (index) => w.document.querySelector(`.participant-card[data-participant-index="${index}"] .participant-item-warning`),
  };
}

test('AC-001: other participants with no selected services show a small warning in their heading', async () => {
  const f = await setup();
  try {
    assert.equal(f.warning(0)?.hidden, true, 'No warning before any service is chosen');
    assert.equal(f.warning(1)?.hidden, true);
    f.w.dispatchEvent(new f.w.CustomEvent('booking:selection-changed', {
      detail: { items: [{ serviceId: '20000000-0000-4000-8000-000000000001', quantity: 1 }] },
    }));
    assert.equal(f.warning(0)?.hidden, true, 'Selected participant must not show warning');
    assert.equal(f.warning(1)?.hidden, false, 'Unselected second participant needs a warning');
    assert.equal(f.warning(1)?.textContent, '還未選擇預約項目');
    assert.ok(f.warning(1)?.closest('summary strong'), 'Warning must be beside the participant title');

    f.card(1).querySelector('.service-add-button').click();
    assert.equal(f.warning(1)?.hidden, true, 'Warning clears as soon as services are selected');
    f.card(1).querySelector('.selected-service-remove').click();
    assert.equal(f.warning(1)?.hidden, false, 'Warning returns when the last service is removed');

    f.w.dispatchEvent(new f.w.CustomEvent('booking:selection-changed', { detail: { items: [] } }));
    assert.equal(f.warning(0)?.hidden, true);
    assert.equal(f.warning(1)?.hidden, true, 'No warnings when no participant has started selecting');
  } finally {
    f.dom.window.close();
  }
});

test('AC-002: expanding another participant moves the beginning of its technician selection into view', async () => {
  const f = await setup();
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.scrolls.length, 0, 'Initial rendering must not steal scroll position');
    const card = f.card(1);
    assert.equal(card.open, false);
    const summary = card.querySelector('summary');
    summary.click();
    assert.equal(card.open, true);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(f.scrolls.length > 0, 'Expanding a participant must scroll to that participant');
    const last = f.scrolls.at(-1);
    assert.equal(last.element, summary, 'Keep the participant heading visible immediately above technician selection');
    assert.equal(last.options.block, 'start');
    const beforeClose = f.scrolls.length;
    summary.click();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.scrolls.length, beforeClose, 'Closing a participant must not scroll');
  } finally {
    f.dom.window.close();
  }
});

test('AC-003: a replaced participant card must not cause delayed scrolling', async () => {
  const f = await setup();
  try {
    const staleCard = f.card(1);
    staleCard.querySelector('summary').click();
    const party = f.w.document.getElementById('bookingPartySize');
    party.value = '3';
    party.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(staleCard.isConnected, false);
    assert.equal(f.scrolls.length, 0, 'Stale animation callbacks cannot scroll an unrelated card');
  } finally {
    f.dom.window.close();
  }
});
