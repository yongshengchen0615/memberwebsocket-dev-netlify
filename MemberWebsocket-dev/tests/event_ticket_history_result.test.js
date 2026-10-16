const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('used lottery ticket history opens the persisted history snapshot', () => {
  const event = read('event/app.js');
  const html = read('event/index.html');

  assert.ok(event.includes("button.addEventListener('click', () => openTicketModal(eventTicketIdForOffer(offer), { preferHistory: true }));"));
  assert.ok(event.includes('async function openTicketModal(eventTicketId, options = {})'));
  assert.ok(event.includes('const offer = findOffer(targetId, options)'));
  assert.ok(event.includes('function findOffer(eventTicketId, options = {})'));
  assert.ok(event.includes('const activeOffer = state.offers.find'));
  assert.ok(event.includes('const historyOffer = state.usedTickets.find'));
  assert.ok(event.includes('if (options.preferHistory === true) return historyOffer || activeOffer || null;'));
  assert.ok(event.includes("if (activeOffer && String(activeOffer?.claim?.status || '') === 'used' && historyOffer) return historyOffer;"));
  assert.ok(event.includes('return activeOffer || historyOffer || null;'));
  assert.match(event, /if \(history && claim && ticket\.ticketType === 'lottery' && claim\.result\) \{\s+renderRedeemedResult/);
  assert.match(html, /<script src="\.\/app\.js\?v=[^"]+" defer><\/script>/);
});

test('active ticket actions keep the normal active-first lookup path', () => {
  const event = read('event/app.js');

  assert.ok(event.includes('const offer = findOffer(state.pendingEventTicketId);'));
  assert.ok(event.includes('return activeOffer || historyOffer || null;'));
});
