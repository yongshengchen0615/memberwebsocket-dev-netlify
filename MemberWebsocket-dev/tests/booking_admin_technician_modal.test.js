const fs = require('node:fs');
const assert = require('node:assert/strict');

const resources = fs.readFileSync('MemberWebsocket-dev/admin/booking-resources.js', 'utf8');
const loader = fs.readFileSync('MemberWebsocket-dev/admin/booking-panel.js', 'utf8');
const styles = fs.readFileSync('MemberWebsocket-dev/admin/booking-resources.css', 'utf8');

assert.match(resources, /bookingAdminTechnicianModal/);
assert.match(resources, /bookingAdminTechnicianActiveTab/);
assert.match(resources, /bookingAdminTechnicianDisabledTab/);
assert.match(resources, /function setTechnicianTab\(/);
assert.match(resources, /function restoreTechnician\(/);
assert.match(resources, /function disableTechnician\(/);
assert.match(resources, /booking:technician-disabled/);
assert.match(resources, /已停用，已移至/);
assert.match(resources, /主要技師不可直接停用/);
assert.match(resources, /booking:technician-restored/);
assert.match(resources, /恢復公開/);
assert.match(resources, /已公開/);
assert.match(resources, /已停用/);
assert.match(resources, /admin\.booking\.resources\.technician\.save/);
assert.match(resources, /＋ 新增技師/);

assert.doesNotMatch(resources, /bookingAdminTechnicianDeleteConfirm/);
assert.doesNotMatch(resources, /admin\.booking\.resources\.technician\.delete/);
assert.doesNotMatch(resources, /function deleteTechnicianRequest\(/);
assert.doesNotMatch(resources, /function openDeleteTechnicianConfirm\(/);
assert.doesNotMatch(resources, /刪除技師/);
assert.doesNotMatch(resources, /window\.confirm/);

assert.match(loader, /booking-technician-disable-action-20260920-1/);
assert.doesNotMatch(loader, /booking-technician-delete\.js/);
assert.equal(fs.existsSync('MemberWebsocket-dev/booking-technician-delete.js'), false);

assert.match(styles, /booking-admin-technician-modal-card/);
assert.match(styles, /booking-admin-technician-tabs/);
assert.match(styles, /booking-admin-technician-tab\.active/);
assert.match(styles, /booking-admin-technician-status-action/);
assert.doesNotMatch(styles, /booking-admin-technician-delete-confirm/);

console.log('booking admin technician publish/disable lifecycle wiring OK');
