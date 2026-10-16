const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('regular booking admin has a dedicated no-show filter', () => {
  const core = read('admin/booking-panel-core.js');
  const start = core.indexOf('aria-label="一般預約狀態篩選"');
  const completed = core.indexOf('data-booking-filter="completed"', start);
  const noShow = core.indexOf('data-booking-filter="no_show"', start);
  const all = core.indexOf('data-booking-filter="all"', start);
  assert.ok(start >= 0 && completed < noShow && noShow < all);
  assert.match(core, /\['pending','confirmed','completed','no_show','all'\]\.includes\(filter\)/);
  assert.match(core, /booking\.status === state\.filter/);
});

test('member no-show records occupy their own group', () => {
  const member = read('booking/member-ui.js');
  assert.match(member, /key: 'no_show', title: '無故未到'/);
  assert.match(member, /if \(item\.classList\.contains\('status-no_show'\)\) return 'no_show'/);
  assert.match(member, /目前沒有無故未到的紀錄/);
  assert.match(read('booking/index.html'), /已預約、已完成、無故未到與已取消/);
});

test('history lookup includes no-shows but does not allow member cross-account reads', () => {
  const api = read('supabase/functions/booking-api/index.ts');
  assert.match(api, /\.eq\("member_id", member\.id\)\s*\.eq\("status", "no_show"\)/);
  assert.match(api, /\.eq\("status", "no_show"\)\s*\.order\("booking_date", \{ ascending: false \}\)/);
  assert.match(api, /bookingRows\.set\(row\.id, row\)/);
  assert.match(api, /noShows\.data \|\| \[\]/);
});
