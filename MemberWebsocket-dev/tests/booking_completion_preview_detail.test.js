const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin/booking-panel-core.js'), 'utf8');
const start = source.indexOf('  function completionPreviewData(booking, group) {');
const end = source.indexOf('\n  function openCompletionPreview(', start);
assert.ok(start >= 0 && end > start, 'extract actual browser preview calculation');
const actualCalculation = source.slice(start, end).trim();

function calculate({ booking, group, services = [], types = [], primaryTechnicianId = 'main-tech' }) {
  const context = {
    STORE_SERVICE_ID: '00000000-0000-4000-8000-000000000010',
    state: {
      booking: { primaryTechnicianId },
      catalog: { services, serviceTypes: types },
    },
    bookingVisibleItems: (value) => (value.items || [])
      .filter((item) => item.serviceId !== '00000000-0000-4000-8000-000000000010'),
    participantLabel: (index) => '第 ' + (index + 1) + ' 位',
  };
  return vm.runInNewContext('(' + actualCalculation + ')', context)(booking, group);
}

const booking = {
  items: [
    { serviceId: 'a', serviceTitle: '腳40', unitDurationMinutes: 30, unitPriceAmount: 300, quantity: 2, serviceType: '腳底', countsTowardMembership: true },
    { serviceId: 'b', serviceTitle: '手部服務', unitDurationMinutes: 40, unitPriceAmount: 400, quantity: 1, serviceType: '手部', countsTowardMembership: true },
    { serviceId: '00000000-0000-4000-8000-000000000010', unitDurationMinutes: 10, quantity: 1 },
  ],
  totalDurationMinutes: 70,
};

test('primary-tech-only settlement: two portions use stored 30-minute unit snapshot, not title or current catalog', () => {
  const preview = calculate({
    booking,
    group: {
      totalDurationMinutes: 70,
      participants: [
        { technicianId: 'main-tech', technicianName: '主要技師', isPrimaryTechnician: true, storeServiceMinutes: 10, items: [
          { serviceId: 'a', serviceTitle: '腳40', unitDurationMinutes: 30, unitPriceAmount: 300, quantity: 2 },
        ] },
        { technicianId: 'second-tech', technicianName: '其他技師', isPrimaryTechnician: false, storeServiceMinutes: 10, items: [
          { serviceId: 'b', serviceTitle: '手部服務', unitDurationMinutes: 40, unitPriceAmount: 400, quantity: 1 },
        ] },
      ],
    },
    services: [
      { serviceId: 'a', durationMinutes: 40, serviceType: '腳底' },
      { serviceId: 'b', durationMinutes: 40, serviceType: '手部' },
    ],
    types: [{ name: '腳底', rewardMinutesPerPoint: 30, rewardPointCardId: 'reward-card', rewardPointCardTitle: '足部點卡' }],
  });
  assert.equal(preview.serviceMinutes, 60, 'only primary technician receives membership minutes');
  assert.equal(preview.allServiceMinutes, 100, 'all participants still appear in service totals');
  assert.equal(preview.totalAmount, 1000, 'all participants are included in gross service amount');
  assert.equal(preview.scheduleMinutes, 70, 'schedule is not confused with aggregate member time');
  assert.equal(preview.totalRewardPoints, 2);
  assert.equal(preview.people.length, 2);
  assert.equal(preview.people[0].items[0].unitMinutes, 30);
  assert.equal(preview.people[0].items[0].quantity, 2);
  assert.equal(preview.people[0].items[0].subtotalAmount, 600);
  assert.equal(preview.people[1].eligibleMinutes, 0);
  assert.equal(preview.people[1].items[0].isEligible, false);
  assert.equal(preview.hasDurationDifference, true, 'catalog edits must not silently change historical item minutes');
});

test('catalog-only item does not inflate minutes or points, and store minutes are excluded', () => {
  const preview = calculate({
    booking: { items: booking.items.slice(0, 1) },
    group: { participants: [{
      technicianId: 'second-tech', items: [{ serviceId: 'a', unitDurationMinutes: 30, unitPriceAmount: 300, quantity: 2 }], storeServiceMinutes: 10,
    }] },
    services: [{ serviceId: 'a', durationMinutes: 40, serviceType: '腳底' }],
  });
  assert.equal(preview.serviceMinutes, 0);
  assert.equal(preview.totalRewardPoints, 0);
  assert.equal(preview.allServiceMinutes, 60);
});

test('zero-minute snapshots do not fall back to current catalog service minutes', () => {
  const preview = calculate({
    booking: { items: [] },
    group: { participants: [{
      technicianId: 'main-tech', isPrimaryTechnician: true,
      items: [{ serviceId: 'a', unitDurationMinutes: 0, unitPriceAmount: 0, quantity: 1 }],
    }] },
    services: [{ serviceId: 'a', durationMinutes: 40, priceAmount: 500 }],
  });
  assert.equal(preview.serviceMinutes, 0);
  assert.equal(preview.totalAmount, 0);
});

test('missing participant details are recognized as unsafe for settlement confirmation', () => {
  const preview = calculate({ booking, group: { participants: [] } });
  assert.equal(preview.hasParticipantDetails, false);
  assert.equal(preview.serviceMinutes, 0);
  assert.match(source, /preview\.hasParticipantDetails \? '' : 'disabled'/);
  assert.match(source, /if \(!preview\.hasParticipantDetails\) return;/);
});

test('completion preview exposes itemized minutes, amount, notes, and business feature gates', () => {
  assert.match(source, /item\.unitMinutes.*分鐘／份.*item\.quantity.*item\.subtotalMinutes/);
  assert.match(source, /formatMoney\(item\.unitPrice\).*formatMoney\(item\.subtotalAmount\)/);
  assert.match(source, /booking\.memberNote/);
  assert.match(source, /bookingContactName\(booking\)/);
  assert.match(source, /data-business-requires="booking points"/);
  assert.match(source, /data-business-requires="booking points\|events"/);
  assert.match(source, /真正的服務時間、集點、LINE 通知與重複請求判斷仍由 Server-side 完成結算流程決定/);
});
