const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../..');

for (const mode of ['direct', 'approval']) {
  test('AC-001/002: member booking UI follows server cancellation mode: ' + mode, async () => {
    const html = fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: 'https://bookings.test/booking/?business=test-shop',
      runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    const tick = () => new Promise(resolve => setTimeout(resolve, 30));
    const cfg = { supabaseUrl: 'https://db.test', supabasePublishableKey: 'publishable-test' };
    const bookingId = '30000000-0000-4000-8000-000000000001';
    const serviceId = '20000000-0000-4000-8000-000000000001';
    const booking = { bookingId, status: 'confirmed', updatedAt: '2026-11-24T09:00:00Z',
      bookingDate: '2099-01-02', startTime: '10:00', endTime: '11:00',
      items: [{ serviceId, serviceTitle: '測試服務', quantity: 1 }] };
    const data = { today: '2026-11-24', settings: { minAdvanceDays: 0,
      workStartTime: '09:00', workEndTime: '18:00' },
      services: [{ serviceId, title: '測試服務', durationMinutes: 60,
        priceAmount: 100, isActive: true }], bookings: [booking] };
    let requested = false;
    const calls = [];
    w.MembershipProgress = { render() {} };
    w.confirm = () => true;
    w.matchMedia = () => ({ matches: false });
    w.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'member.list') return new Response(JSON.stringify({
        ok: true, data: { cancellationMode: mode,
          requests: requested && mode === 'approval' ? [{
            bookingId, cancellationRequestedAt: '2026-11-24T10:00:00Z',
          }] : [] },
      }));
      if (body.action === 'member.request') {
        requested = true;
        if (mode === 'direct') booking.status = 'cancelled';
        return new Response(JSON.stringify({ ok: true, data: {
          directCancelled: mode === 'direct',
          request: { cancellationRequestedAt: '2026-11-24T10:00:00Z' },
        } }));
      }
      throw Error('Unexpected endpoint ' + body.action);
    };
    w.BookingSystem = {
      loadConfig: async () => cfg,
      signIn: async () => 'test-token',
      subscribeRealtime: () => () => {},
      memberProfile: async () => ({}),
      addDays: (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10),
      formatDate: x => x,
      request: async (_config, _type, _token, action) => {
        if (action === 'user.booking.bootstrap') return structuredClone(data);
        if (action === 'user.booking.slots') return { slots: [] };
        throw Error('Unexpected action ' + action);
      },
    };
    try {
      w.eval(fs.readFileSync(path.join(root, 'booking/onsite-edit-policy.js'), 'utf8'));
      w.eval(fs.readFileSync(path.join(root, 'booking/member-ui.js'), 'utf8'));
      w.eval(fs.readFileSync(path.join(root, 'booking/app.js'), 'utf8'));
      await tick(); await tick();
      const expectedLabel = mode === 'direct' ? '取消預約' : '申請取消';
      const button = [...w.document.querySelectorAll('.booking-item button')]
        .find(b => b.textContent.trim() === expectedLabel);
      assert.ok(button, 'must render mode-specific cancellation button ' + expectedLabel);
      assert.equal(button.disabled, false);
      button.click();
      await tick(); await tick();
      assert.equal(calls.filter(c => c.action === 'member.request').length, 1);
      assert.equal(calls.find(c => c.action === 'member.request').bookingId, bookingId);
      if (mode === 'direct') {
        assert.equal(booking.status, 'cancelled');
        assert.match(w.document.getElementById('bookingList').textContent, /已取消/);
        assert.doesNotMatch(w.document.getElementById('bookingList').textContent, /取消待確認/);
      } else {
        assert.equal(booking.status, 'confirmed');
        assert.match(w.document.getElementById('bookingList').textContent, /取消待確認/);
      }
    } finally { w.close(); }
  });
}
