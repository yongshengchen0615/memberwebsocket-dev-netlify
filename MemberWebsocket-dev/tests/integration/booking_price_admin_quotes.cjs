// Run with the repository's integration-test dependencies on NODE_PATH.
// This executes the actual dialog and request transport; it stubs only the
// surrounding page services and network response. No database is modified.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('admin item editor submits the displayed price after a background catalog refresh', async () => {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
  const dom = new JSDOM('<h3 id="title"></h3><div id="body"></div>', {
    runScripts: 'outside-only', url: 'https://example.test/admin/',
  });
  const w = dom.window;
  const serviceId = '10000000-0000-4000-8000-000000000001';
  const version1 = '20000000-0000-4000-8000-000000000001';
  const version2 = '20000000-0000-4000-8000-000000000002';
  let sent;
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  try {
    w.eval(fs.readFileSync(path.join(root, 'booking-price-publishing.js'), 'utf8'));
    w.state = { config:{pricePublishing:true}, catalog: { services: [{
      serviceId, title: 'Synthetic service', priceAmount: 500,
      priceVersion: version1, durationMinutes: 30, isActive: true,
    }] } };
    w.els = {
      bookingAdminCrudModalTitle: w.document.getElementById('title'),
      bookingAdminCrudModalBody: w.document.getElementById('body'),
    };
    w.STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
    w.formatMoney = value => 'NT$' + value;
    w.showModal = () => {};
    w.closeModal = () => {};
    w.showMessage = () => {};
    w.runModalAction = async fn => {
      try { await fn(); } finally { finish(); }
    };
    w.bookingVisibleItems = () => [{ serviceId, quantity: 1 }];
    w.context = async () => ({
      config: { pricePublishing: true, supabaseUrl: 'https://example.test' },
      idToken: 'synthetic-token',
    });
    w.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      return { ok: true, text: async () => JSON.stringify({ ok: true, data: {} }) };
    };

    const transportStart = source.indexOf('  async function requestFunction');
    const transportEnd = source.indexOf('  function isBackgroundE2ERunner', transportStart);
    const modalStart = source.indexOf('  function openBookingItemsModal');
    const modalEnd = source.indexOf('  async function openBookingBenefitsModal', modalStart);
    assert.ok(transportStart >= 0 && transportEnd > transportStart);
    assert.ok(modalStart >= 0 && modalEnd > modalStart);
    w.eval(source.slice(transportStart, transportEnd) + '\n' +
      source.slice(modalStart, modalEnd) + '\nwindow.openTest = openBookingItemsModal;');

    w.openTest({ bookingId: 'synthetic-booking', updatedAt: '2026-11-05T00:00:00Z' });
    const visiblePrice = w.document.querySelector('[data-booking-item-rows] small');
    assert.match(visiblePrice.textContent, /NT\$500/);

    // refreshAll replaces state.catalog without rebuilding an open modal.
    w.state.catalog = { services: [{ ...w.state.catalog.services[0],
      priceAmount: 800, priceVersion: version2,
    }] };
    assert.match(visiblePrice.textContent, /NT\$500/);
    w.document.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await completed;

    assert.equal(sent.action, 'admin.booking.items.update');
    assert.deepEqual(sent.expectedPrices, [{ serviceId, priceAmount: 500, priceVersion: version1 }],
      'The transaction must validate the price shown in this modal, so a changed price requires reconfirmation.');
  } finally {
    w.close();
  }
});
