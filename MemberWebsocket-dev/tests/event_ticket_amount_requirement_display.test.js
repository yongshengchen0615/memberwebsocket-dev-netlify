const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root,file),'utf8');

function amountLabel(row, entries) {
  const api = read('supabase/functions/api/index.ts');
  const start = api.indexOf('function ticketBookingAmountLabel(');
  const end = api.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'event bootstrap amount formatter exists');
  const code = stripTypeScriptTypes(api.slice(start,end+2));
  const fn = vm.runInNewContext(code + '\nticketBookingAmountLabel',{Map,Set});
  return fn(row,new Map(entries));
}

function renderCard(ticket, options={showServiceRequirement:true,showAmountRequirement:true}) {
  const window = {};
  const document = {
    createElement(tag) {
      return {
        tag, textContent:'', children:[], className:'',
        classList:{add(){}}, style:{setProperty(){}},
        append(...nodes){this.children.push(...nodes)},
      };
    },
    createTextNode(textContent){return {textContent}},
  };
  vm.runInNewContext(read('event-ticket-ui.js'),{window,document});
  const rootNode=window.EventTicketUI.create(ticket,options);
  const text=(node)=>String(node.textContent||'')+(node.children||[]).map(text).join('');
  return text(rootNode);
}

test('AC-001: legacy ticket has no new money condition, and service condition remains',()=>{
  assert.equal(amountLabel({min_booking_amount_mode:'none',min_booking_amount:0},[]),'');
  assert.equal(amountLabel({},[]),'');
  const html = renderCard({title:'原活動券',requiredServiceRequirementLabel:'需預約「頭部舒壓」項目'});
  assert.match(html,/預約項目條件.*需預約「頭部舒壓」項目/);
  assert.doesNotMatch(html,/金額使用條件/);
});

test('AC-002: total minimum displays exactly on member ticket and booking amount is not a payment deduction',()=>{
  const label=amountLabel({min_booking_amount_mode:'total',min_booking_amount:1800},[]);
  assert.equal(label,'一般預約總金額滿 NT$1,800');
  assert.match(renderCard({title:'滿額券',minBookingAmountLabel:label}),/金額使用條件.*一般預約總金額滿 NT\$1,800/);
  assert.doesNotMatch(renderCard({title:'普通券'}),/金額使用條件/);
});

test('AC-003: selected-item minimum shows the actual service names and cumulative selected subtotal',()=>{
  const label=amountLabel({min_booking_amount_mode:'selected_services',min_booking_amount:880,min_booking_service_ids:['a','b']},
    [['a','按摩 60 分鐘'],['b','足浴 30 分鐘']]);
  assert.equal(label,'一般預約指定項目「按摩 60 分鐘、足浴 30 分鐘」合計滿 NT$880');
  assert.match(renderCard({minBookingAmountLabel:label}),/金額使用條件.*按摩 60 分鐘、足浴 30 分鐘.*合計滿 NT\$880/);
  assert.doesNotMatch(label,/(\ba\b|\bb\b)/);
});

test('AC-004: missing service info does not expose IDs or silently hide an active restriction',()=>{
  const label=amountLabel({min_booking_amount_mode:'selected_services',min_booking_amount:500,min_booking_service_ids:['unsafe-uuid']},[]);
  assert.match(label,/已停用項目/);
  assert.doesNotMatch(label,/unsafe-uuid/);
  assert.match(amountLabel({min_booking_amount_mode:'selected_services',min_booking_amount:500,min_booking_service_ids:[]},[]),/條件資料異常/);
  assert.match(amountLabel({min_booking_amount_mode:'weird',min_booking_amount:500},[]),/條件資料異常/);
});

test('AC-005: only member ticket cards get a second rule row; detail shows rule, legacy booking card stays unchanged',()=>{
  const ticket={title:'活動券',minBookingAmountLabel:'一般預約總金額滿 NT$500'};
  assert.doesNotMatch(renderCard(ticket,{}),/金額使用條件/);
  const app=read('event/app.js');
  const html=read('event/index.html');
  assert.match(app,/showServiceRequirement: true, showAmountRequirement: true/);
  assert.match(app,/els\.ticketModalAmountRequirement\.textContent/);
  assert.match(app,/ticket\.minBookingAmountLabel/);
  assert.match(html,/id="ticketModalAmountRequirement" class="ticket-description hidden"/);
  assert.match(html,/event-ticket-ui\.js\?v=[^"]*amount-condition-20261110-1/);
  assert.match(html,/event\/app\.js|\.\/app\.js\?v=[^"]*amount-condition-20261110-1/);
});

test('AC-006: API resolves selected service ids for ticket cards; booking UI retains its own amount label',()=>{
  const api=read('supabase/functions/api/index.ts');
  const benefits=read('supabase/functions/_shared/booking-benefits.ts');
  assert.match(api,/Array\.isArray\(row\.min_booking_service_ids\) \? row\.min_booking_service_ids : \[\]/);
  assert.match(api,/minBookingAmountLabel: ticketBookingAmountLabel\(row,serviceTitles\)/);
  assert.match(api,/from\("booking_services"\)\.select\("id,title"\)/);
  assert.match(benefits,/minBookingAmountLabel/);
  assert.match(benefits,/conditionLabel: [^\n]*minBookingAmountLabel/);
  assert.doesNotMatch(read('event-ticket-ui.js'),/innerHTML/);
});

function bookingAmountLabel(offer, entries) {
  const benefits=read('supabase/functions/_shared/booking-benefits.ts');
  const start=benefits.indexOf("const minBookingAmountMode = offer.minBookingAmountMode || 'none';");
  const end=benefits.indexOf('\n        return {',start);
  assert.ok(start>=0 && end>start, 'booking benefits formats event ticket amount conditions');
  const format=new Function('offer','requiredServiceTitleById',
    benefits.slice(start,end) + '\nreturn { minBookingAmountLabel,minBookingServiceTitles };');
  return format(offer,new Map(entries));
}

test('AC-007: booking selected-amount ticket resolves service titles even without a separate service restriction',()=>{
  const benefits=read('supabase/functions/_shared/booking-benefits.ts');
  assert.match(benefits,/events\.flatMap\(\(offer\) => Array\.isArray\(offer\.minBookingServiceIds\)/);
  const result=bookingAmountLabel({
    minBookingAmountMode:'selected_services',minBookingAmount:800,minBookingServiceIds:['service-only-amount']
  },[['service-only-amount','美甲護理']]);
  assert.deepEqual(result.minBookingServiceTitles,['美甲護理']);
  assert.equal(result.minBookingAmountLabel,'一般預約指定項目「美甲護理」合計滿 NT$800');
  assert.equal(bookingAmountLabel({minBookingAmountMode:'none',minBookingAmount:0},[]).minBookingAmountLabel,'不限金額');
});

test('AC-008: booking amount label hides identifiers and fails visibly on invalid configuration',()=>{
  const missing=bookingAmountLabel({
    minBookingAmountMode:'selected_services',minBookingAmount:1500,minBookingServiceIds:['opaque-uuid']
  },[]);
  assert.equal(missing.minBookingAmountLabel,'一般預約指定項目「已停用項目」合計滿 NT$1,500');
  assert.doesNotMatch(missing.minBookingAmountLabel,/opaque-uuid/);
  assert.match(bookingAmountLabel({minBookingAmountMode:'selected_services',minBookingAmount:800,minBookingServiceIds:[]},[]).minBookingAmountLabel,/資料異常/);
});
