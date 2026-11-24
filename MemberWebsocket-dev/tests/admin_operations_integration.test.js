const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'admin', 'app.js'), 'utf8');
const booking = fs.readFileSync(path.join(root, 'admin', 'booking-panel-core.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'admin', 'booking-panel.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin', 'styles.css'), 'utf8');

test('member 360 consolidates member summary and cross-domain actions', () => {
  assert.match(html, /id="memberRecordsModalTitle">會員 360</);
  assert.match(html, /id="memberRecordsOverview"/);
  assert.match(app, /function renderMemberRecordsOverview\(\)/);
  assert.match(app, /\['會員等級'/);
  assert.match(app, /\['累積服務時間'/);
  assert.match(app, /statusAction\.textContent = '狀態'/);
  assert.match(app, /grantAction\.textContent = '＋ 發放'/);
  assert.doesNotMatch(app, /actionButton\('狀態', 'edit-member'/);
  assert.doesNotMatch(app, /actionButton\('＋ 發放', 'add-grant'/);
});

test('three isolated calendar workspaces render their own content and keep booking snapshot private', () => {
  assert.match(html, /aria-controls="calendarPanel">會員活動</);
  assert.match(html, /id="eventTicketCalendarGrid"/);
  assert.match(html, /id="adminCalendarGrid"/);
  assert.match(booking, /id="bookingOverviewCalendarGrid"/);
  assert.match(app, /member-admin:booking-snapshot/);
  assert.match(app, /member-admin:booking-snapshot-request/);
  assert.match(app, /renderBookingOverviewCalendar\(\)/);
  assert.match(app, /rows: state\.operationalBookings\.filter/);
  assert.match(app, /rules\.belongsToScope\('activity', item\)/);
  assert.match(app, /rules\.belongsToScope\(kind, item\)/);
  assert.match(app, /member-admin:booking-focus/);
  assert.match(css, /\.admin-calendar-booking/);
  assert.doesNotMatch(html, /id="calendarBatchRows"/);
});


test('booking admin publishes a least-privilege calendar snapshot and supports focus handoff', () => {
  assert.match(booking, /function publishOperationalBookingSnapshot\(\)/);
  for (const key of ['bookingId', 'bookingDate', 'startTime', 'endTime', 'status', 'memberDisplayName', 'memberCode', 'technicianName', 'partySize']) {
    assert.ok(booking.includes(key + ':'), 'missing safe snapshot field ' + key);
  }
  assert.doesNotMatch(booking.slice(booking.indexOf('function publishOperationalBookingSnapshot'), booking.indexOf('function handleOperationalSnapshotRequest')), /contactPhone|memberNote|adminNote|idToken/);
  assert.match(booking, /member-admin:booking-focus/);
  assert.match(booking, /card\.classList\.add\('is-calendar-target'\)/);
  assert.match(loader, /layout-stability-20261001-1/);
});
