const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../booking/group-booking.js'), 'utf8');
const start = source.indexOf('  function syncBenefitServiceContext() {');
const end = source.indexOf('\n  function participantServiceNames(', start);
assert.ok(start >= 0 && end > start, 'group-booking actual context must be extractable');

function generalBookingAmountContext(state) {
  const collected = [];
  const window = { BookingBenefits: { setServiceContext(rows) { collected.push(rows); } } };
  const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
  // Evaluate the actual application function with isolated synthetic inputs.
  const actual = new Function('window','state','STORE_SERVICE_ID',
    source.slice(start,end) + '\nreturn syncBenefitServiceContext;')(window,state,STORE_SERVICE_ID);
  actual();
  assert.equal(collected.length,1,'exactly one new context per group update');
  return Object.fromEntries(collected[0].map(({serviceId,amount})=>[serviceId,amount]));
}

const state = (primaryItems,extras) => ({
  primaryItems,
  extras,
  services: [
    {serviceId:'A',priceAmount:100},
    {serviceId:'B',priceAmount:200},
    {serviceId:'00000000-0000-4000-8000-000000000010',priceAmount:50},
  ],
});

test('AC-010: group booking amount gate sums both participants, quantity, and store once',()=>{
  const amounts = generalBookingAmountContext(state([{serviceId:'A',quantity:2}],[
    [{serviceId:'B'},{serviceId:'B'}],
  ]));
  assert.deepEqual(amounts,{'A':200,'B':400,'00000000-0000-4000-8000-000000000010':50});
  assert.equal(Object.values(amounts).reduce((a,b)=>a+b,0),650);
});

test('AC-011: group booking repeated service across members aggregates rather than replacing',()=>{
  const amounts = generalBookingAmountContext(state([{serviceId:'A',quantity:1}],[
    [{serviceId:'A'},{serviceId:'A'}],
  ]));
  assert.equal(amounts.A,300);
  assert.equal(amounts['00000000-0000-4000-8000-000000000010'],50);
});

test('AC-012: empty booking has no store charge or eligible event amount',()=>{
  assert.deepEqual(generalBookingAmountContext(state([],[])),{});
});
