const fs = require('node:fs');
const assert = require('node:assert/strict');

const loader = fs.readFileSync('MemberWebsocket-dev/admin/booking-panel.js', 'utf8');
const resources = fs.readFileSync('MemberWebsocket-dev/admin/booking-resources.js', 'utf8');

assert.ok(loader.includes('Promise.allSettled(preloadExtensions.map'));
assert.ok(loader.includes('booking-always-open.js'));
assert.ok(loader.includes('booking-cancellation-sync.js'));
assert.ok(loader.includes('booking-panel-core.js'));
assert.ok(loader.includes('booking-resources.js'));
assert.ok(loader.includes('booking-technician-disable-action-20260920-1'));
assert.ok(!loader.includes('booking-summary.js'));
assert.ok(!loader.includes('booking-admin-group-details.js'));
assert.ok(!loader.includes('booking-technician-delete.js'));

const preloadIndex = loader.indexOf('Promise.allSettled');
const coreIndex = loader.indexOf("load('booking-panel-core.js'");
const resourcesIndex = loader.indexOf("['booking-resources.js'");
assert.ok(preloadIndex >= 0 && coreIndex > preloadIndex);
assert.ok(resourcesIndex >= 0 && resourcesIndex < coreIndex);

assert.ok(resources.includes('bookingAdminTechnicianModal'));
assert.ok(resources.includes('bookingAdminTechnicianActiveTab'));
assert.ok(resources.includes('bookingAdminTechnicianDisabledTab'));
assert.ok(resources.includes('restoreTechnician'));
assert.ok(resources.includes('admin.booking.resources.technician.save'));
assert.ok(!resources.includes('admin.booking.resources.technician.delete'));
assert.ok(!resources.includes('bookingAdminTechnicianDeleteConfirm'));
assert.ok(!resources.includes('window.confirm'));
assert.equal(fs.existsSync('MemberWebsocket-dev/booking-technician-delete.js'), false);
assert.equal(fs.existsSync('MemberWebsocket-dev/booking/admin/resources.js'), false);

console.log('booking admin loads only current technician lifecycle renderer');
