const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pendingRows = [{ receiptId: 'receipt-a', status: 'awaiting_review', requestedBenefits: [{ title: '票券 A' }] }];

function fixture(request = async () => ({ submissions: pendingRows })) {
  const dom = new JSDOM(read('booking/index.html'), {
    url: 'https://example.test/booking/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const add = w.addEventListener.bind(w);
  w.addEventListener = (name, ...args) => {
    if (!['DOMContentLoaded', 'pageshow'].includes(name)) add(name, ...args);
  };
  let currentSession = { config: {}, idToken: 'fixture-a' };
  w.BookingSystem = { getSession: () => currentSession, request };
  w.BookingBenefits = { getItems: () => [] };
  w.eval(read('booking/booking-receipt.js'));
  w.eval(read('booking/booking-accessible.js'));
  const emit = (name, detail) => w.dispatchEvent(new w.CustomEvent(name, { detail }));
  const render = rows => emit('booking:receipts-updated', { submissions: rows });
  const member = id => emit('booking:member-loaded', { profile: { lineUserId: id } });
  member('member-a');
  return { dom, w, emit, render, member, setSession: value => { currentSession = value; } };
}

test('snapshot refresh preserves expanded receipts while updating their contents', () => {
  const f = fixture();
  try {
    f.render(pendingRows);
    f.w.document.querySelector('[data-receipt-id="receipt-a"]').open = true;
    f.render([{ ...pendingRows[0], requestedBenefits: [{ title: '最新票券' }] }]);
    const row = f.w.document.querySelector('[data-receipt-id="receipt-a"]');
    assert.equal(row.open, true);
    assert.match(row.textContent, /最新票券/);
    f.render([]);
    f.render(pendingRows);
    assert.equal(f.w.document.querySelector('[data-receipt-id="receipt-a"]').open, false);
  } finally { f.dom.window.close(); }
});

test('snapshot refresh retains keyboard focus on the selected tab and receipt summary', () => {
  const f = fixture();
  try {
    f.render(pendingRows);
    const doc = f.w.document;
    doc.querySelector('#snapshotHistoryTab-pending').focus();
    f.render(pendingRows);
    assert.equal(doc.activeElement.id, 'snapshotHistoryTab-pending');
    doc.querySelector('[data-receipt-id="receipt-a"] summary').focus();
    f.render(pendingRows);
    assert.equal(doc.activeElement, doc.querySelector('[data-receipt-id="receipt-a"] summary'));
    doc.querySelector('#bookingAccessibleToggle').focus();
    f.render(pendingRows);
    assert.equal(doc.activeElement.id, 'bookingAccessibleToggle', 'refresh must not steal outside focus');
  } finally { f.dom.window.close(); }
});

test('switching identity discards an old receipt response and permits a new read immediately', async () => {
  const deferred = [];
  const f = fixture((_config, _surface, token) => new Promise(resolve => deferred.push({ token, resolve })));
  const published = [];
  f.w.addEventListener('booking:receipts-updated', event => published.push(event.detail.submissions));
  try {
    const first = f.w.BookingReceipts.refresh();
    f.setSession({ config: {}, idToken: 'fixture-b' });
    f.member('member-b');
    const second = f.w.BookingReceipts.refresh();
    assert.equal(deferred.length, 2, 'old pending request must not block the new identity');
    deferred[0].resolve({ submissions: pendingRows });
    await first;
    assert.ok(published.every(rows => rows.length === 0), 'old member receipts must never be published');
    await f.w.BookingReceipts.refresh();
    assert.equal(deferred.length, 2, 'old finally must not release the new request lock');
    deferred[1].resolve({ submissions: [{ receiptId: 'receipt-b', status: 'bound' }] });
    await second;
    assert.equal(f.w.document.querySelectorAll('#bookingSnapshotHistory details').length, 1);
    assert.equal(f.w.document.querySelector('#bookingSnapshotHistory details').dataset.receiptId, 'receipt-b');
  } finally { f.dom.window.close(); }
});

test('access termination clears receipt controls and rejects late responses', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const published = [];
  f.w.addEventListener('booking:receipts-updated', event => published.push(event.detail.submissions));
  try {
    f.render(pendingRows);
    published.length = 0;
    const control = f.w.document.createElement('button');
    control.dataset.bookingReceiptControl = '1';
    f.w.document.getElementById('bookingList').append(control);
    const read = f.w.BookingReceipts.refresh();
    f.setSession(null);
    f.emit('member:access-ended', { code: 'SESSION_REVOKED' });
    assert.equal(f.w.document.querySelectorAll('[data-booking-receipt-control]').length, 0);
    assert.equal(f.w.document.getElementById('bookingSnapshotHistory').hidden, true);
    resolve({ submissions: pendingRows });
    await read;
    assert.ok(published.every(rows => rows.length === 0));
  } finally { f.dom.window.close(); }
});

test('an obsolete receipt failure does not replace the new identity status', async () => {
  let reject;
  const f = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
  let errors = 0;
  f.w.addEventListener('booking:receipt-load-error', () => { errors += 1; });
  try {
    const read = f.w.BookingReceipts.refresh();
    f.setSession({ config: {}, idToken: 'fixture-b' });
    f.member('member-b');
    reject(new Error('old request failed'));
    await read;
    assert.equal(errors, 0);
  } finally { f.dom.window.close(); }
});

test('refreshing the same member does not clear current receipts or duplicate an active read', async () => {
  let resolve;
  let calls = 0;
  const f = fixture(() => { calls += 1; return new Promise(done => { resolve = done; }); });
  try {
    f.render(pendingRows);
    const read = f.w.BookingReceipts.refresh();
    f.member('member-a');
    await f.w.BookingReceipts.refresh();
    assert.equal(calls, 1);
    assert.equal(f.w.document.querySelectorAll('#bookingSnapshotHistory details').length, 1);
    resolve({ submissions: pendingRows });
    await read;
    f.w.document.querySelector('#bookingSnapshotHistory details').open = true;
    f.member('member-b');
    f.render(pendingRows);
    assert.equal(f.w.document.querySelector('#bookingSnapshotHistory details').open, false);
  } finally { f.dom.window.close(); }
});
