const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../frontdesk/app.js'), 'utf8');

test('AC-FD-CONFIRM-001: confirmation requires a second explicit approval before the write', () => {
 assert.match(app, /else if\(confirmFrontdeskReview\(booking,'confirmed'\)\)void review\(booking,next,b\)/);
 assert.match(app, /return window\.confirm\(/);
});

test('AC-FD-CONFIRM-002: rejection requires reason validation and an additional confirmation', () => {
 assert.match(app, /if\(!reason\.value\)/);
 assert.match(app, /if\(!frozen&&!confirmFrontdeskReview\(booking,'rejected'/);
 assert.match(app, /if\(busy\)return/);
});

test('AC-FD-CONFIRM-003: rejection of a phone conflict displays replacement details', () => {
 assert.match(app, /if\(phoneBooking\)details\.push/);
 assert.match(app, /phoneBooking\.totalDurationMinutes/);
});

test('AC-FD-LOADING-001: both frontdesk review actions show shared loading until completion', () => {
 assert.match(app, /AsyncActionFeedback\?\.begin\(next==='confirmed'/);
 assert.match(app, /finally\{finishFeedback\?\.\(\);lock\(false\);\}/);
});
