const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../..');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(getValue, timeoutMs = 1600) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = getValue();
    if (value) return value;
    await tick(25);
  }
  return getValue();
}
const bookingId = '30000000-0000-4000-8000-000000000001';
const booking = { bookingId, bookingDate: '2026-09-17', startTime: '09:00:00', endTime: '10:00:00', memberDisplayName: '測試會員', memberCode: 'M001', contactSurname: '王', contactSalutation: 'mr', contactPhone: '0912-345-678', items: [{ serviceId: '10000000-0000-4000-8000-000000000001', serviceTitle: '腳底40', quantity: 1, unitDurationMinutes: 40, subtotalAmount: 800 }], totalDurationMinutes: 40, totalAmount: 800, status: 'pending', updatedAt: '2026-09-17T00:00:00.000Z' };
const group = { partySize: 2, participants: [
  { technicianName: '甲（主要技師）', items: [{ serviceTitle: '腳底40', quantity: 1 }] },
  { technicianName: '乙', items: [{ serviceTitle: '肩頸', quantity: 2 }] },
] };
const expected = '營業日 2026-09-17｜09:00–10:00\n王先生\n電話：0912345678\n預約人數：2 位\n\n第一位預約\n預約項目：腳底40\n預約技師：甲\n\n第二位預約\n預約項目：肩頸 × 2\n預約技師：乙';

for (const entry of ['admin']) {
  test(`${entry}: real copy button uses participant format exactly once`, async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, entry, 'index.html'), 'utf8'), { url: `https://example.test/MemberWebsocket-dev/${entry}/`, runScripts: 'outside-only' });
    const w = dom.window;
    const observers = [];
    const NativeObserver = w.MutationObserver;
    w.MutationObserver = class extends NativeObserver {
      constructor(callback) { super(callback); observers.push(this); }
    };
    const copied = [];
    const actions = [];
    let mode = 'group';
    const system = { loadConfig: async () => ({ supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' }), request: async () => ({ bookings: [structuredClone(booking)], services: [] }) };
    w.MemberSystem = system;
    w.BookingSystem = system;
    w.isSecureContext = true;
    w.navigator.clipboard = { writeText: async text => copied.push(text) };
    w.fetch = async (url, init) => {
      const { action, clientType, idToken, bookingIds } = JSON.parse(init.body);
      actions.push(action);
      assert.equal(clientType, 'admin');
      assert.equal(idToken, 'fixture-token');
      let data;
      if (action === 'admin.booking.bootstrap') data = { bookings: [booking], settings: {} };
      else if (action === 'admin.booking.manage.bootstrap') data = { settings: {}, services: [], serviceTypes: [] };
      else if (action === 'admin.booking.resources.bootstrap') data = {
        settings: { maxPartySize: 2, primaryTechnicianId: '20000000-0000-4000-8000-000000000001' },
        technicians: [
          { technicianId: '20000000-0000-4000-8000-000000000001', name: '甲', isActive: true, sortOrder: 0 },
          { technicianId: '20000000-0000-4000-8000-000000000002', name: '乙', isActive: true, sortOrder: 1 },
        ],
      };
      else if (action === 'admin.booking.contacts') data = { contacts: [booking] };
      else if (action === 'admin.booking.summary') data = { pendingCount: 1, unreadCount: 1, latestNotificationId: 1 };
      else if (action === 'admin.booking.notifications.read') data = { unreadCount: 0, latestNotificationId: 1 };
      else {
        assert.equal(action, 'admin.booking.group.details');
        assert.deepEqual(bookingIds, [bookingId]);
        if (mode === 'failure') return new Response(JSON.stringify({ ok: false, error: { code: 'AUTH_INVALID' } }), { status: 401 });
        data = { bookingGroups: { [bookingId]: mode === 'single' ? { partySize: 1, participants: [] } : group } };
      }
      return new Response(JSON.stringify({ ok: true, data }));
    };
    const load = file => w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    try {
      // Verify real entrypoint URLs resolve to committed files, not a missing path.
      const formatScript = [...w.document.querySelectorAll('script[src]')].find(s => s.src.includes('booking-copy-format.js'));
      assert.ok(formatScript);
      for (const node of w.document.querySelectorAll('[src], link[href]')) {
        const src = node.getAttribute('src') || node.getAttribute('href');
        if (!src.includes('booking-admin-group-details.') && !src.includes('booking-copy-format.js')) continue;
        assert.ok(fs.existsSync(path.resolve(root, entry, src.split('?')[0])), src);
      }
      load('admin/admin-session.js');
      w.MemberAdminSession.establish(
        { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' },
        'fixture-token'
      );
      let queue;
      load('admin/booking-panel-core.js');
      if (!w.document.getElementById('bookingTab')) {
        w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
        await tick(20);
      }
      const bookingTab = w.document.getElementById('bookingTab');
      assert.ok(bookingTab);
      bookingTab.click();
      queue = w.document.getElementById('bookingAdminQueue');
      load('booking-copy-text.js');
      load('booking-copy-format.js');
      load('booking-copy-format.js'); // Cached dynamic loader must not install twice.
      const button = await waitFor(() => queue.querySelector('.booking-copy-button'));
      assert.ok(button, [
        'booking copy control should render after the authoritative booking bootstrap',
        'actions=' + actions.join(','),
        'sync=' + (w.document.getElementById('bookingAdminSyncStatus')?.textContent || ''),
        'message=' + (w.document.getElementById('bookingAdminServiceMessage')?.textContent || ''),
        'queue=' + String(queue.innerHTML || '').slice(0, 500),
      ].join(' | '));
      button.click();
      button.click();
      await tick(20);
      assert.deepEqual(copied, [expected]);
      assert.equal(button.textContent, '已複製');
      await tick(1550);
      mode = 'failure';
      button.click();
      await tick(20);
      assert.deepEqual(copied, [expected, expected], 'Main admin should copy from canonical rendered data without a second details request');
      assert.equal(button.textContent, '已複製');
      await tick(1550);
      mode = 'single';
      button.click();
      await tick(20);
      assert.equal(copied[2], expected, 'Main admin copy stays pinned to the single-renderer data model');
    } finally { observers.forEach(observer => observer.disconnect()); w.close(); }
  });
}


test('legacy booking admin entry redirects to current admin booking workspace', () => {
  const html = fs.readFileSync(path.join(root, 'booking/admin/index.html'), 'utf8');
  assert.match(html, /http-equiv="refresh" content="0; url=\.\.\/\.\.\/admin\/#booking"/);
  assert.match(html, /href="\.\.\/\.\.\/admin\/#booking"/);
  assert.equal(fs.existsSync(path.join(root, 'booking/admin/app.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'booking/admin/contact-details.js')), false);
});
