const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

const root = join(__dirname, '../..');

async function run() {
  const dom = new JSDOM(readFileSync(join(root, 'admin/index.html'), 'utf8'), {
    url: 'https://example.test/admin/', runScripts: 'outside-only',
  });
  const { window } = dom;
  Object.defineProperty(window.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition(success) {
        success({
          coords: { latitude: 22.997, longitude: 120.212, accuracy: 12 },
          timestamp: Date.now(),
        });
      },
    },
  });
  let geocodeCalls = 0;
  const geocodeUrls = [];
  window.fetch = async (url) => {
    geocodeCalls += 1;
    geocodeUrls.push(String(url));
    return {
      ok: true,
      json: async () => geocodeCalls === 1
        ? []
        : [{ display_name: '中山路, 台南市', lat: '22.9968', lon: '120.2131' }],
    };
  };

  window.eval(readFileSync(join(root, 'admin/coupon-location-editor.js'), 'utf8'));
  window.TicketLocationEditors.init();
  const editor = window.CouponLocationEditor;
  const templateEditor = window.TicketLocationEditors.template;
  const $ = (id) => window.document.getElementById(id);

  assert.ok($('eventTicketForm').contains($('eventTicketLocationMap')), 'event map must stay inside ticket form');
  assert.ok($('ticketForm').contains($('ticketLocationMap')), 'template map must stay inside ticket form');
  assert.ok($('eventTicketAddressSearch'), 'event ticket address search must exist');
  assert.ok($('ticketAddressSearch'), 'point-ticket template address search must exist');
  assert.ok($('eventTicketLocationDraft'), 'event ticket confirmation panel must exist');
  assert.ok($('ticketLocationDraft'), 'point-ticket confirmation panel must exist');

  $('eventTicketRequiresLocation').checked = true;
  $('eventTicketRequiresLocation').dispatchEvent(new window.Event('change'));
  assert.equal($('eventTicketLocationControls').classList.contains('hidden'), false);

  editor.set([
    { name: '台北', latitude: 25.033964, longitude: 121.564468, radiusMeters: 150 },
    { name: '台中', latitude: 24.147736, longitude: 120.673648, radiusMeters: 100 },
  ]);
  assert.equal(editor.get().length, 2);
  assert.equal($('eventTicketLocationRows').querySelectorAll('.coupon-location-row').length, 2);
  assert.equal($('eventTicketLocationRows').textContent.includes('緯度'), false, 'latitude must not be shown in admin UI');
  assert.equal($('eventTicketLocationRows').textContent.includes('經度'), false, 'longitude must not be shown in admin UI');
  assert.match($('eventTicketLocationRows').textContent, /150 公尺/, 'saved radius must be visible');

  $('eventTicketLocationRows').querySelector('input').value = '台北門市';
  $('eventTicketLocationRows').querySelector('input').dispatchEvent(new window.Event('input'));
  assert.equal(editor.get()[0].name, '台北門市');
  $('eventTicketLocationRows').querySelectorAll('.coupon-location-row')[1].querySelector('button:last-child').click();
  assert.deepEqual(editor.get().map((place) => place.name), ['台北門市']);

  editor.set([]);
  $('eventTicketUseCurrentLocationButton').click();
  assert.equal(editor.get().length, 0, 'GPS selection must not add before confirmation');
  assert.equal($('eventTicketLocationDraft').classList.contains('hidden'), false);
  assert.equal($('eventTicketLocationDraftName').value, '目前 GPS 位置');
  $('eventTicketLocationDraftRadius').value = '180';
  $('eventTicketLocationDraftRadius').dispatchEvent(new window.Event('input'));
  $('addEventTicketLocationButton').click();
  assert.equal(editor.get().length, 1, 'confirmed GPS candidate must be added');
  assert.equal(editor.get()[0].name, '目前 GPS 位置');
  assert.equal(editor.get()[0].radiusMeters, 180);

  editor.set([]);
  $('eventTicketAddressSearch').value = '台南市中西區中山路999號8樓';
  await editor.searchAddress();
  assert.equal(geocodeCalls, 2, 'missing exact address must trigger one rate-limited nearby fallback');
  assert.match(geocodeUrls[0], /countrycodes=tw/);
  assert.match(decodeURIComponent(geocodeUrls[1]), /台南市中西區中山路/);
  const searchResult = $('eventTicketAddressResults').querySelector('button');
  assert.ok(searchResult, 'nearby fallback must render a selectable result');
  assert.match(searchResult.textContent, /附近候選/);
  assert.match($('eventTicketMapStatus').textContent, /最接近/);
  searchResult.click();
  assert.equal(editor.get().length, 0, 'nearby address result must remain a candidate until confirmation');
  assert.match($('eventTicketLocationDraftName').value, /中山路/);
  $('addEventTicketLocationButton').click();
  assert.equal(editor.get().length, 1);
  assert.match(editor.get()[0].name, /中山路/);

  editor.set([]);
  editor.setDraft(22.99, 120.21, '候選地點', { radiusMeters: 300 });
  assert.equal(editor.get().length, 0, 'map-like candidate selection must not mutate saved locations');
  assert.equal($('eventTicketLocationDraftRadius').value, '300');
  $('clearEventTicketLocationDraftButton').click();
  assert.equal(editor.get().length, 0);
  assert.equal($('eventTicketLocationDraft').classList.contains('hidden'), true);

  $('ticketRequiresLocation').checked = true;
  $('ticketRequiresLocation').dispatchEvent(new window.Event('change'));
  templateEditor.set([{ name: '集點票券門市', latitude: 23.0, longitude: 120.2, radiusMeters: 120 }]);
  assert.equal(templateEditor.get().length, 1);
  assert.equal($('ticketLocationControls').classList.contains('hidden'), false);
  assert.equal($('ticketLocationCount').textContent, '1 / 20 個使用地點');
  assert.equal($('ticketLocationRows').textContent.includes('緯度'), false);
  assert.equal($('ticketLocationRows').textContent.includes('經度'), false);

  // Real-browser fallback: watchPosition can fail with POSITION_UNAVAILABLE
  // even when getCurrentPosition still returns a valid device location.
  const browserDom = new JSDOM(readFileSync(join(root, 'admin/index.html'), 'utf8'), {
    url: 'https://example.test/admin/', runScripts: 'outside-only',
  });
  const browser = browserDom.window;
  // The snapshot editor is rendered dynamically by booking-panel-core.js in
  // production. Supply only its DOM controls for this isolated picker test.
  browser.document.body.insertAdjacentHTML('beforeend', `
    <input type="checkbox" id="bookingAdminSnapshotLocationRequired">
    <div id="bookingAdminSnapshotLocationControls" class="hidden">
      <div id="bookingAdminSnapshotLocationRows"></div>
      <span id="bookingAdminSnapshotLocationCount"></span>
      <p id="bookingAdminSnapshotMapStatus"></p>
      <div id="bookingAdminSnapshotLocationMap"></div>
      <div id="bookingAdminSnapshotLocationDraft" class="hidden">
        <input id="bookingAdminSnapshotLocationDraftName">
        <input id="bookingAdminSnapshotLocationDraftRadius" value="100">
        <button id="addBookingAdminSnapshotLocationButton" type="button">新增地點</button>
        <button id="clearBookingAdminSnapshotLocationDraftButton" type="button">取消</button>
      </div>
      <button id="bookingAdminSnapshotUseCurrentLocationButton" type="button">使用即時 GPS 選點</button>
      <input id="bookingAdminSnapshotAddressSearch">
      <button id="bookingAdminSnapshotAddressSearchButton" type="button">搜尋</button>
      <div id="bookingAdminSnapshotAddressResults"></div>
    </div>`);
  try {
    Object.defineProperty(browser, 'isSecureContext', { configurable: true, value: true });
    const watches = [];
    const cleared = [];
    const oneShots = [];
    Object.defineProperty(browser.navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(_onFix, onError, options) {
          watches.push({ onError, options });
          return watches.length - 1;
        },
        clearWatch(id) { cleared.push(id); },
        getCurrentPosition(onFix, onError, options) { oneShots.push({ onFix, onError, options }); },
      }
    });
    browser.eval(readFileSync(join(root, 'ticket-live-location.js'), 'utf8'));
    browser.eval(readFileSync(join(root, 'admin/coupon-location-editor.js'), 'utf8'));
    const snapshot = browser.TicketLocationEditors.snapshot;
    const get = id => browser.document.getElementById(id);
    snapshot.init();
    get('bookingAdminSnapshotLocationRequired').checked = true;
    get('bookingAdminSnapshotLocationRequired').dispatchEvent(new browser.Event('change'));
    get('bookingAdminSnapshotUseCurrentLocationButton').click();
    assert.equal(watches.length, 1);
    watches[0].onError({ code: 2 });
    assert.deepEqual(cleared, [0], 'the failed live GPS watch must be stopped');
    assert.equal(oneShots.length, 1, 'retry unavailable watch with one real single GPS fix');
    assert.equal(oneShots[0].options.enableHighAccuracy, true);
    assert.match(get('bookingAdminSnapshotMapStatus').textContent, /單次定位/);
    assert.equal(snapshot.get().length, 0, 'no location may be saved before confirmation');
    oneShots[0].onFix({
      coords: { latitude: 22.997, longitude: 120.212, accuracy: 15 },
      timestamp: Date.now(),
    });
    assert.equal(get('bookingAdminSnapshotLocationDraft').classList.contains('hidden'), false);
    assert.equal(get('bookingAdminSnapshotLocationDraftName').value, '目前 GPS 位置');
    assert.equal(snapshot.get().length, 0);
    get('addBookingAdminSnapshotLocationButton').click();
    assert.equal(snapshot.get().length, 1);
    assert.equal(snapshot.get()[0].latitude, 22.997);

    // If both browser APIs fail, map and address alternatives are available;
    // retries must not reuse a failed watch or accept stale callbacks.
    snapshot.set([]);
    get('bookingAdminSnapshotUseCurrentLocationButton').click();
    watches[1].onError({ code: 2 });
    assert.equal(oneShots.length, 2);
    oneShots[1].onError({ code: 2 });
    assert.match(get('bookingAdminSnapshotMapStatus').textContent, /地址搜尋.*地圖/);
    assert.equal(get('bookingAdminSnapshotUseCurrentLocationButton').textContent, '使用即時 GPS 選點');
    get('bookingAdminSnapshotUseCurrentLocationButton').click();
    assert.equal(watches.length, 3, 'a fresh click must start a new watch');
    watches[2].onError({ code: 2 });
    assert.equal(oneShots.length, 3);
    get('bookingAdminSnapshotUseCurrentLocationButton').click(); // cancel pending fallback
    oneShots[2].onFix({
      coords: { latitude: 22.99, longitude: 120.21, accuracy: 15 },
      timestamp: Date.now(),
    });
    assert.equal(snapshot.get().length, 0);
    assert.equal(get('bookingAdminSnapshotLocationDraft').classList.contains('hidden'), true,
      'late cancelled GPS must not reopen a location draft');
  } finally {
    browser.close();
  }

  console.log('all-ticket location editor: passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
