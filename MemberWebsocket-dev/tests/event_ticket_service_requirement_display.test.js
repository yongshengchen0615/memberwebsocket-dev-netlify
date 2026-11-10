const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function serviceLabel(row, entries) {
  const api = read('supabase/functions/api/index.ts');
  const start = api.indexOf('function ticketRequiredServiceLabel(');
  assert.ok(start !== -1, 'event bootstrap must have a reusable requirement formatter');
  const end = api.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'formatter function must have a closing brace');
  const source = stripTypeScriptTypes(api.slice(start, end + 2));
  const format = vm.runInNewContext(source + '\nticketRequiredServiceLabel', { Map, Set });
  return format(row, new Map(entries));
}

function ticketCard(ticket, options = {}) {
  const window = {};
  const document = {
    createElement(tag) {
      return {
        tag, children: [], textContent: '', className: '',
        classList: { add() {} },
        style: { setProperty() {} },
        append(...children) { this.children.push(...children); },
      };
    },
    createTextNode(value) { return { textContent: value }; },
  };
  vm.runInNewContext(read('event-ticket-ui.js'), { window, document });
  const card = window.EventTicketUI.create(ticket, options);
  const plain = (node) => String(node.textContent || '') + (node.children || []).map(plain).join('');
  return plain(card);
}

test('AC-001: event ticket shows the exact required booking item but unrestricted tickets do not', () => {
  const titles = [['service-a', '身體 60 分鐘']];
  assert.equal(serviceLabel({ required_service_ids: [] }, titles), '');
  const requirement = serviceLabel({ required_service_ids: ['service-a'], required_service_match_mode: 'any' }, titles);
  assert.equal(requirement, '需預約「身體 60 分鐘」項目');
  assert.match(ticketCard({ title: '優惠活動', requiredServiceRequirementLabel: requirement }, { showServiceRequirement: true }), /預約項目條件.*需預約「身體 60 分鐘」項目/);
  assert.doesNotMatch(ticketCard({ title: '優惠活動' }, { showServiceRequirement: true }), /預約項目條件/);
  assert.doesNotMatch(ticketCard({ title: '優惠活動', requiredServiceRequirementLabel: requirement }), /預約項目條件/, 'booking page already has a condition row');
});

test('AC-002: all/any/alternative groups describe their real logical conditions', () => {
  const titles = [['s1', '按摩 60'], ['s2', '足浴 30'], ['s3', '臉部保養']];
  assert.equal(serviceLabel({ required_service_ids: ['s1', 's2'], required_service_match_mode: 'any' }, titles), '需預約「按摩 60、足浴 30」其中一個項目');
  assert.equal(serviceLabel({ required_service_ids: ['s1', 's2'], required_service_match_mode: 'all' }, titles), '需預約所有指定項目：「按摩 60、足浴 30」');
  assert.equal(serviceLabel({ required_service_groups: [['s1', 's2'], ['s3']] }, titles), '需預約「按摩 60＋足浴 30」或「臉部保養」其中一組的所有項目');
});

test('AC-003: missing service catalog entries never leak raw database IDs or conceal a restriction', () => {
  const label = serviceLabel({ required_service_ids: ['unknown-uuid'], required_service_match_mode: 'any' }, []);
  assert.match(label, /已停用項目/);
  assert.doesNotMatch(label, /unknown-uuid/);
});

test('AC-004: bootstrap supplies resolved conditions to event cards and the detail dialog', () => {
  const api = read('supabase/functions/api/index.ts');
  const app = read('event/app.js');
  const html = read('event/index.html');
  assert.match(api, /requiredServiceRequirementLabel: ticketRequiredServiceLabel\(/);
  assert.match(api, /from\("booking_services"\)/);
  assert.match(app, /showServiceRequirement: true/);
  assert.match(app, /ticketModalServiceRequirement/);
  assert.match(html, /id="ticketModalServiceRequirement"/);
});
