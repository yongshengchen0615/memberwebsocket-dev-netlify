const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../booking/group-booking.js'), 'utf8');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.open = false;
    this.className = '';
  }
  appendChild(element) { this.children.push(element); return element; }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = [...elements]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }
  querySelectorAll(selector) {
    assert.equal(selector, 'details.participant-card');
    return this.children.filter((element) => element.tagName === 'details' && element.className === 'participant-card');
  }
}

function makeParticipantForm(count = 3) {
  const start = source.indexOf('  function renderParticipantCards() {');
  const end = source.indexOf('\n  function createTechnicianField(', start);
  assert.ok(start >= 0 && end > start, 'group booking render function must exist');

  const root = new FakeElement('div');
  const state = {
    partySize: count,
    activeParticipantIndex: 0,
    primaryPicker: new FakeElement('fieldset'),
    primarySelected: new FakeElement('fieldset'),
    extras: [[], []],
    participantTechnicians: ['primary', 'second', 'third'],
  };
  const context = {
    state,
    document: {
      getElementById(id) { return id === 'participantCardList' ? root : null; },
      createElement(tagName) { return new FakeElement(tagName); },
    },
    participantLabel(index) { return `第${index + 1}位預約`; },
    createTechnicianField() { return new FakeElement('label'); },
    createExtraServicePicker() { return new FakeElement('fieldset'); },
    updateCardSummaries() {},
    updateSelectionSummary() {},
  };
  const render = vm.runInNewContext(source.slice(start, end) + '\nrenderParticipantCards', context);
  const expanded = () => root.children
    .filter((element) => element.open)
    .map((element) => Number(element.dataset.participantIndex));
  const click = (index) => {
    const summary = root.children[index].children[0];
    assert.equal(summary.tagName, 'summary');
    let prevented = false;
    summary.listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'prevent native details toggling');
  };
  return { render, root, state, expanded, click };
}

test('AC-001: moving between group booking participants keeps exactly one card open', () => {
  const form = makeParticipantForm();
  form.render();
  assert.deepEqual(form.expanded(), [0]);

  for (const index of [1, 2, 0, 2, 1]) {
    form.click(index);
    assert.deepEqual(form.expanded(), [index]);
    assert.equal(form.state.activeParticipantIndex, index);
  }

  form.click(1);
  assert.deepEqual(form.expanded(), [1], 'clicking the open participant does not collapse every card');
});

test('AC-002: switching cards preserves existing participant selections and form nodes', () => {
  const form = makeParticipantForm();
  form.state.extras[0].push({ serviceId: 'service-2' });
  form.render();
  const firstCard = form.root.children[0];
  const firstPicker = form.state.primaryPicker;
  const initialTechnicians = [...form.state.participantTechnicians];

  form.click(2);
  form.click(0);
  assert.strictEqual(form.root.children[0], firstCard, 'switching does not recreate the form');
  assert.strictEqual(firstCard.children[1].children[1], firstPicker);
  assert.equal(form.state.extras[0][0].serviceId, 'service-2');
  assert.deepEqual(form.state.participantTechnicians, initialTechnicians);
});

test('AC-003: reducing participant count resets out-of-range expanded card', () => {
  const form = makeParticipantForm();
  form.render();
  form.click(2);
  form.state.partySize = 2;
  form.render();
  assert.equal(form.root.children.length, 2);
  assert.deepEqual(form.expanded(), [0]);
  assert.equal(form.state.activeParticipantIndex, 0);

  form.state.partySize = 1;
  form.render();
  assert.deepEqual(form.expanded(), [0]);
});

test('AC-004: service and technician form updates keep the participant being edited expanded', () => {
  assert.match(source, /state\.participantTechnicians\[index\] = String\(select\.value \|\| ''\);\s*state\.activeParticipantIndex = index;\s*renderParticipantCards\(\);/);
  const numberOfFocusedUpdates = (source.match(/state\.activeParticipantIndex = index;/g) || []).length;
  assert.equal(numberOfFocusedUpdates, 4, 'heading switch, technician change, service add and service remove');
  assert.doesNotMatch(source, /openCards|index === 0;\s*details\.addEventListener\('toggle'/);
});
