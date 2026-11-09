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


function render({ booking: value, group, services = [], types = [], primaryTechnicianId = 'main-tech', adminNote = '管理端補充' }) {
  const start = source.indexOf('  function openCompletionPreview(booking, adminNote) {');
  const end = source.indexOf('\n  function updateNoShowButtons()', start);
  assert.ok(start >= 0 && end > start);
  const documentBody = {
    innerHTML: '',
    querySelector() { return { querySelector() { return { addEventListener() {} }; }, addEventListener() {} }; },
  };
  const element = { bookingAdminCrudModalTitle: { textContent: '' }, bookingAdminCrudModalBody: documentBody };
  const escapeHtml = (input) => String(input ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const context = {
    els: element,
    state: { booking: { groups: { [value.bookingId]: group } } },
    completionPreviewData: () => calculate({ booking: value, group, services, types, primaryTechnicianId }),
    escapeHtml,
    bookingContactName: () => '陳先生',
    formatMoney: (number) => 'NT$' + Number(number),
    bookingBenefitDisplayTitle: (benefit) => benefit.title,
    bookingBenefitKindLabel: (benefit) => benefit.kind,
    closeModal() {},
    showModal() {},
  };
  vm.runInNewContext('(' + source.slice(start, end).trim() + ')', context)(value, adminNote);
  return { html: documentBody.innerHTML, title: element.bookingAdminCrudModalTitle.textContent };
}

test('real settlement renderer shows separate participant totals, correct eligibility, contact and notes', () => {
  const result = render({
    booking: {
      ...booking, bookingId: 'test-booking', memberDisplayName: '小胖', memberCode: 'M001',
      bookingDate: '2026-11-09', startTime: '13:00', endTime: '14:10',
      memberNote: '<私人備註>', contactPhone: '09xx-xxx-xxx',
    },
    group: { participants: [
      { technicianId: 'main-tech', technicianName: 'A 技師', isPrimaryTechnician: true, items: [
        { serviceId: 'a', serviceTitle: '腳40', unitDurationMinutes: 30, unitPriceAmount: 300, quantity: 2 },
      ] },
      { technicianId: 'secondary', technicianName: 'B 技師', items: [
        { serviceId: 'b', serviceTitle: '手部服務', unitDurationMinutes: 40, unitPriceAmount: 400, quantity: 1 },
      ] },
    ] },
    services: [{ serviceId: 'a', durationMinutes: 40 }, { serviceId: 'b', durationMinutes: 40 }],
    adminNote: '<管理備註>',
  });
  assert.match(result.title, /完成結算預覽/);
  assert.match(result.html, /30 分鐘／份 × 2 份 = 60 分鐘/);
  assert.match(result.html, /NT\$300 × 2 = NT\$600/);
  assert.match(result.html, /NT\$400/);
  assert.match(result.html, /非主要技師/);
  assert.match(result.html, /將計入會員時間（主要技師）/);
  assert.match(result.html, /所有服務項目分鐘（含其他技師）/);
  assert.match(result.html, /100 分鐘/);
  assert.match(result.html, /60 分鐘/);
  assert.match(result.html, /NT\$1000/);
  assert.match(result.html, /&lt;私人備註&gt;/);
  assert.match(result.html, /&lt;管理備註&gt;/);
  assert.doesNotMatch(result.html, /<私人備註>|<管理備註>/);
  assert.match(result.html, /快照分鐘數不同於目前項目設定/);
  assert.doesNotMatch(result.html, /type="submit" disabled/);
});

test('renderer blocks confirmation when one participant is missing item details', () => {
  const result = render({
    booking: { ...booking, bookingId: 'test-missing' },
    group: { participants: [
      { technicianId: 'main-tech', isPrimaryTechnician: true, items: [
        { serviceId: 'a', unitDurationMinutes: 30, unitPriceAmount: 300, quantity: 2 },
      ] },
      { technicianId: 'other', items: [] },
    ] },
  });
  assert.match(result.html, /請關閉畫面並重新同步預約資料後再結算/);
  assert.match(result.html, /type="submit" disabled/);
});
