const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'admin', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin', 'styles.css'), 'utf8');

test('member 360 has a clear hero, activity heading, and responsive surface', () => {
  assert.match(html, /data-member-360-surface/);
  assert.match(html, /member-records-modal-subtitle/);
  assert.match(html, /Activity timeline/);
  assert.match(css, /width:\s*min\(94vw, 1040px\)/);
  assert.match(css, /\.member-records-avatar/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test('member 360 overview exposes status, metrics, and primary actions', () => {
  assert.match(app, /member-records-overview-hero/);
  assert.match(app, /member-records-status/);
  assert.match(app, /is-disabled/);
  assert.match(app, /\['會員等級'/);
  assert.match(app, /\['累積服務時間'/);
  assert.match(app, /statusAction\.textContent = '狀態'/);
  assert.match(app, /grantAction\.textContent = '＋ 發放'/);
  assert.match(app, /state\.memberRecords\.childOpener = statusAction/);
  assert.match(app, /state\.memberRecords\.childOpener = grantAction/);
});

test('member 360 summary tiles work as direct activity filters', () => {
  assert.match(app, /handleMemberRecordsSummaryClick/);
  assert.match(app, /data-record-summary-filter/);
  assert.match(app, /pill\.setAttribute\('aria-pressed'/);
  assert.match(css, /\.member-record-summary-pill\.active/);
  assert.match(css, /\.member-record-summary-pill:focus-visible/);
});

test('member 360 history is rendered as a theme-token timeline', () => {
  assert.match(css, /\.member-records-list::before/);
  assert.match(css, /\.member-record-item::before/);
  assert.match(css, /--member-record-accent/);
  assert.match(css, /category-bookings/);
  assert.match(css, /category-eventTickets/);
  assert.doesNotMatch(css.slice(css.indexOf('Member 360 UI polish 2026-09-25')), /color-mix\(/);
});

test('member 360 contact fields preserve phone and birthday, including empty values', () => {
  const start = app.indexOf('  function memberProfileContactFields(member) {');
  const end = app.indexOf('\n  function renderMemberRecordsOverview()', start);
  assert.ok(start >= 0 && end > start, 'contact mapping must remain independently testable');
  const fields = new Function(app.slice(start, end) + '\nreturn memberProfileContactFields;')();
  assert.deepEqual(fields({ phone: '0912345678', birthday: '1994-06-15' }), [
    ['聯絡電話', '0912345678'],
    ['生日', '1994/06/15'],
  ]);
  assert.deepEqual(fields({ phone: '  +819012345678  ', birthday: ' 2000-02-29 ' }), [
    ['聯絡電話', '+819012345678'],
    ['生日', '2000/02/29'],
  ]);
  assert.deepEqual(fields({ phone: null, birthday: '' }), [
    ['聯絡電話', '未填寫'],
    ['生日', '未填寫'],
  ]);
  assert.deepEqual(fields(null), [['聯絡電話', '未填寫'], ['生日', '未填寫']]);
});

test('member 360 renders contact values as text and does not change activity metrics or actions', () => {
  const api = fs.readFileSync(path.join(root, 'supabase', 'functions', 'api', 'index.ts'), 'utf8');
  assert.match(api, /birthday: member\.birthday \|\| ""/);
  assert.match(api, /phone: member\.phone \|\| ""/);
  assert.match(app, /contact\.className = 'member-records-overview-contact'/);
  assert.match(app, /memberProfileContactFields\(member\)\.forEach/);
  assert.match(app, /contactValue\.textContent = value/);
  assert.match(app, /copy\.append\(eyebrow, title, meta, contact\)/);
  assert.match(css, /\.member-records-overview-contact\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.member-records-overview-contact strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(app, /\['會員等級',/);
  assert.match(app, /\['累積服務時間',/);
  assert.match(app, /actions\.append\(statusAction, grantAction, removeAction\)/);
});
