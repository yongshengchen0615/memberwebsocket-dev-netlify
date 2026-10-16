const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const api = read('supabase/functions/api/index.ts');
const points = read('points/app.js');
const overview = read('points/pointcard-ticket-overview.js');
const html = read('points/index.html');

function pendingSnapshotPoints(tickets, perTicketReceipts) {
  const block = api.match(/const snapshotReservedStampsByCard = new Map<string,number>\(\);([\s\S]*?)\n  const cardIdByUuid/);
  assert.ok(block, 'production snapshot reservation reducer exists');
  const source = ('const snapshotReservedStampsByCard = new Map();' + block[1]
    + '\nreturn snapshotReservedStampsByCard;');
  return new Function('availableTickets', 'snapshotByPointTicket', source)(tickets, perTicketReceipts);
}

test('general booking and snapshot for the identical five-point ticket sum to ten', () => {
  const map = pendingSnapshotPoints(
    [{ ticket_id:'PT-5',point_card_id:'card',status:'available',threshold_stamps:5 }],
    new Map([['PT-5',[{receiptId:'BR-1'}]]]),
  );
  assert.equal(map.get('card'), 5);
  const generalReserved = 5;
  const reserved = generalReserved + map.get('card');
  assert.equal(reserved, 10);
  assert.equal(31-reserved, 21);
  assert.match(api, /const reservedStamps = generalReservedStamps \+ snapshotReservedStamps/);
  assert.match(api, /const availableStamps = Math.max\(0, totalStamps - reservedStamps\)/);
});

test('each pending receipt is a separate reservation, without card mixing', () => {
  const totals = pendingSnapshotPoints([
    {ticket_id:'PT-5',point_card_id:'card-a',status:'available',threshold_stamps:5},
    {ticket_id:'PT-10',point_card_id:'card-b',status:'available',threshold_stamps:10},
    {ticket_id:'PT-USED',point_card_id:'card-a',status:'used',threshold_stamps:5},
  ],new Map([
    ['PT-5',[{receiptId:'BR-1'},{receiptId:'BR-2'}]],
    ['PT-10',[{receiptId:'BR-3'}]],
    ['PT-USED',[{receiptId:'BR-4'}]],
  ]));
  assert.equal(totals.get('card-a'),10);
  assert.equal(totals.get('card-b'),10);
  assert.match(api, /snapshots\.some\(item => item\.receiptId === String\(receipt\.receipt_id\)\)/);
  assert.match(api, /\.eq\("status","awaiting_review"\)/);
  assert.ok(!api.includes('pendingSnapshotsFromBoundReceipts'));
});

test('cancelled or approved snapshot does not remain in pending card hold', () => {
  const totals = pendingSnapshotPoints([
    {ticket_id:'PT-5',point_card_id:'card',status:'available',threshold_stamps:5},
  ],new Map());
  assert.equal(totals.get('card') ?? 0,0);
  // Approved redemptions are already reflected in point_balances and must
  // not be subtracted again as if awaiting review.
  assert.match(api, /\.eq\("status","awaiting_review"\)/);
});

test('member card and ticket overview display the same booking breakdown', () => {
  assert.match(api,/generalReservedStamps,/);
  assert.match(api,/snapshotReservedStamps,/);
  assert.match(points,/\$\{reservedStamps\} 點已預約/);
  assert.match(points,/一般預約 \$\{generalReservedStamps\} 點＋快照待審核 \$\{snapshotReservedStamps\} 點/);
  assert.match(points,/generalReservedStamps,\s*snapshotReservedStamps,/);
  assert.match(overview,/一般預約 \$\{generalReserved\} 點＋快照待審核 \$\{snapshotReserved\} 點＝合計/);
  assert.match(html,/pointcard-ticket-overview\.js\?v=[^"]*booking-snapshot-sum-20261014-1/);
  assert.match(html,/app\.js\?v=[^"]*booking-snapshot-sum-20261014-1/);
});
