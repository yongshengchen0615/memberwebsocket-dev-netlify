const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const html = read('event/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 70; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw Error('Timed out: ' + label);
};

function ticket(overrides = {}) {
  return {
    ticket: {
      eventTicketId: 'EVENT-GUIDED', title: '預約限定活動券', ticketType: 'coupon',
      startsOn: '2026-11-01', endsOn: '2026-12-31',
      minBookingAmountMode: 'total', minBookingAmount: 300,
      minBookingAmountLabel: '一般預約總金額滿 NT$300',
    },
    claim: { claimId: 'EC-GUIDED', status: 'available', ticketType: 'coupon' },
    eligibleBookings: [],
    canClaim: false, canUse: false, tierEligible: true, availability: 'active',
    ...overrides,
  };
}

async function setup(offer, options = {}) {
  const dom = new JSDOM(html, {
    url: 'https://qa.example/event/?business=shop-a&token=do-not-forward',
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  let writes = 0;
  w.BusinessContext = { slug: 'shop-a', allows: name => options.bookingDisabled !== true || name !== 'booking' };
  w.MemberSystem = {
    bindDialogKeyboard() {},
    loadConfig: async () => ({}),
    signIn: async () => 'QA synthetic session',
    subscribeRealtime() {},
    request: async (_config, _surface, _token, action) => {
      if (action === 'user.event.bootstrap') return {
        profile: { displayName: 'QA 會員' }, usedTickets: [], usedTicketCount: 0,
        bookingSelections: [], offers: [offer],
      };
      writes++;
      throw Error('unexpected mutation: ' + action);
    },
  };
  w.MembershipProgress = { render() {} };
  w.eval(read('ticket-booking-choice.js'));
  w.eval(read('event-ticket-ui.js'));
  w.eval(read('event/app.js'));
  w.dispatchEvent(new w.Event('DOMContentLoaded'));
  await waitFor(() => w.document.querySelector('#eventList .event-ticket') !== null, 'event cards');
  return { w, dom, writes: () => writes, close: () => dom.window.close() };
}

test('AC-BOOKING-GUIDE-001: owned booking-restricted ticket remains visible and links to standard booking', async () => {
  const h = await setup(ticket());
  try {
    const { document: d } = h.w;
    const card = d.querySelector('#eventList .event-ticket');
    assert.ok(card);
    assert.match(card.textContent, /預約限定活動券/);
    assert.match(card.textContent, /已發放/);
    assert.match(card.textContent, /送出前勾選/);
    const link = card.querySelector('[data-ticket-action="booking-guide"]');
    assert.ok(link);
    assert.equal(link.textContent, '前往預約使用');
    const url = new URL(link.href);
    assert.equal(url.pathname, '/booking/');
    assert.equal(url.searchParams.get('business'), 'shop-a');
    assert.equal(url.searchParams.get('eventTicketId'), 'EVENT-GUIDED');
    assert.equal(url.searchParams.has('token'), false, 'never copy credentials into booking navigation');
    assert.equal(h.w.document.querySelectorAll('[data-ticket-action="claim"]').length, 0);
    assert.equal(h.writes(), 0);
  } finally { h.close(); }
});

test('AC-BOOKING-GUIDE-002: ticket detail shows a second guided link rather than a direct redemption', async () => {
  const h = await setup(ticket());
  try {
    const d = h.w.document;
    d.querySelector('[data-ticket-action="details"]').click();
    const link = d.querySelector('#ticketModal [data-ticket-booking-guide]');
    assert.ok(link && !link.hidden);
    assert.match(link.textContent, /前往預約使用/);
    assert.match(d.querySelector('#ticketModalStatus').textContent, /送出預約前勾選此券/);
    assert.equal(d.querySelector('#ticketModalAction').classList.contains('hidden'), true);
    assert.equal(h.writes(), 0);
  } finally { h.close(); }
});

test('AC-BOOKING-GUIDE-003: direct-use, reserved, exhausted, unauthorized and transferred tickets have no guide', async () => {
  const variants = [
    ticket({ ticket: { eventTicketId: 'EVENT-GUIDED', title: '直接使用票券' }, canUse: true, eligibleBookings: [{ bookingId: 'no-booking' }] }),
    ticket({ reservedForBooking: true }),
    ticket({ soldOut: true }),
    ticket({ tierEligible: false }),
    ticket({ transferredOut: true, claim: null }),
    ticket({ claim: null }),
    ticket({ availability: 'ended' }),
  ];
  for (const offer of variants) {
    const h = await setup(offer);
    try {
      assert.equal(h.w.document.querySelectorAll('[data-ticket-action="booking-guide"]').length, 0,
        'never navigate to booking for an unavailable, direct-use or unissued ticket');
      assert.equal(h.writes(), 0);
    } finally { h.close(); }
  }
  const disabled = await setup(ticket(), { bookingDisabled: true });
  try {
    assert.equal(disabled.w.document.querySelectorAll('[data-ticket-action="booking-guide"]').length, 0);
  } finally { disabled.close(); }
});

test('AC-BOOKING-GUIDE-004: booking handoff never auto-issues and highlights only a matching owned claim', () => {
  const index = read('booking/index.html');
  const benefits = read('booking/booking-benefits.js');
  assert.match(index, /id="bookingTicketGuide"/);
  assert.match(index, /本次可使用優惠/);
  assert.match(benefits, /guidedTicketId/);
  assert.match(benefits, /item\.kind === 'event' && item\.id === guidedTicketId && item\.selectionId/);
  assert.match(benefits, /card\.classList\.add\('is-guided-ticket'\)/);
  assert.doesNotMatch(benefits, /window\.BookingSystem\.claimEventTicket|勾選並領取/);
  assert.match(index, /沒有適用的服務或空閒時段/);
});
