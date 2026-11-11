const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const bookingId = '30000000-0000-4000-8000-000000000071';

test('two member notes remain isolated when collapsing, resizing, editing and cancelling', async () => {
  const dom = new JSDOM(`
    <main>
      <label>舊版整筆備註<textarea id="memberNote"></textarea></label>
      <fieldset class="service-picker-fieldset"><legend>項目</legend></fieldset>
      <fieldset class="selected-service-fieldset"><legend>已選項目</legend></fieldset>
    </main>
  `, { url: 'https://booking.example.test/', runScripts: 'outside-only' });
  const w = dom.window;
  let bookingGroups = {};
  w.BookingSystem = {
    request: async (_config, _type, _token, action) => action === 'user.booking.group.bootstrap'
      ? { settings:{maxPartySize:2,requirePrimaryTechnician:false}, technicians:[],bookingGroups }
      : { bookings:[], settings:{}, services:[] },
    formatDate: date => date,
    clientError: (code, message) => Object.assign(new Error(message), { code }),
  };

  try {
    w.eval(fs.readFileSync(path.join(root, 'booking/group-booking.js'), 'utf8'));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await w.BookingSystem.request({supabaseUrl:'https://fixture.test',supabasePublishableKey:'test'},'member','fake-test-token','user.booking.bootstrap');

    const party = w.document.getElementById('bookingPartySize');
    assert.equal(party.options.length,2);
    assert.equal(w.document.getElementById('memberNote').closest('label').hidden, true);
    party.value = '2';
    party.dispatchEvent(new w.Event('change', { bubbles:true }));

    const notes = () => [...w.document.querySelectorAll('[data-participant-note]')];
    assert.equal(notes().length,2);
    notes()[0].value = '第一位需要安靜';
    notes()[0].dispatchEvent(new w.Event('input', { bubbles:true }));
    notes()[1].value = '第二位力道較輕';
    notes()[1].dispatchEvent(new w.Event('input', { bubbles:true }));
    assert.deepEqual([...w.BookingGroupUI.notesSnapshot()],['第一位需要安靜','第二位力道較輕']);

    w.document.querySelector('[data-participant-index="1"] summary').click();
    assert.equal(w.document.querySelector('[data-participant-index="0"]').open, false);
    assert.equal(w.document.querySelector('[data-participant-index="1"]').open, true);
    assert.equal(notes()[0].value,'第一位需要安靜');
    assert.equal(notes()[1].value,'第二位力道較輕');

    party.value = '1';
    party.dispatchEvent(new w.Event('change', { bubbles:true }));
    assert.deepEqual([...w.BookingGroupUI.notesSnapshot()],['第一位需要安靜']);
    party.value = '2';
    party.dispatchEvent(new w.Event('change', { bubbles:true }));
    assert.deepEqual([...w.BookingGroupUI.notesSnapshot()],['第一位需要安靜','']);

    bookingGroups = { [bookingId]: {partySize:2,participants:[
      {technicianId:'',memberNote:'已儲存的第一位',items:[]},
      {technicianId:'',memberNote:'已儲存的第二位',items:[]},
    ]}};
    await w.BookingSystem.request({supabaseUrl:'https://fixture.test',supabasePublishableKey:'test'},'member','fake-test-token','user.booking.bootstrap');
    const card = w.document.createElement('article');
    card.className='booking-item';
    card.dataset.bookingId=bookingId;
    const edit = w.document.createElement('button');
    edit.textContent='修改預約';
    card.append(edit);
    w.document.body.appendChild(card);
    edit.click();
    assert.deepEqual([...w.BookingGroupUI.notesSnapshot()],['已儲存的第一位','已儲存的第二位']);
    assert.equal(notes()[1].value,'已儲存的第二位');
    w.dispatchEvent(new w.Event('booking:created'));
    assert.deepEqual([...w.BookingGroupUI.notesSnapshot()],['']);
  } finally {
    w.close();
  }
});
