const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = (path) => fs.readFileSync(path, 'utf8');

const adminHtml = read('MemberWebsocket-dev/admin/index.html');
const loader = read('MemberWebsocket-dev/admin/booking-panel.js');
const core = read('MemberWebsocket-dev/admin/booking-panel-core.js');
const styles = read('MemberWebsocket-dev/admin/booking-summary.css');

assert.match(adminHtml, /booking-summary\.css\?v=booking-theme-tokens-20260924-1/);
assert.match(adminHtml, /booking-admin-group-details\.css\?v=booking-theme-tokens-20260924-1/);
assert.match(adminHtml, /booking-panel-responsive\.css\?v=booking-settings-layout-20260918-1/);
assert.doesNotMatch(loader, /loadStyle\(/);
assert.doesNotMatch(loader, /booking-summary\.css/);
assert.doesNotMatch(loader, /booking-admin-group-details\.css/);
assert.doesNotMatch(loader, /\['booking-summary\.js'/);
assert.doesNotMatch(loader, /\['\.\.\/booking-admin-group-details\.js'/);

assert.match(core, /booking-contact-api/);
assert.match(core, /admin\.booking\.contacts/);
assert.match(core, /booking-group-details-api/);
assert.match(core, /admin\.booking\.group\.details/);
assert.match(core, /booking-group-api/);
assert.match(core, /admin\.booking\.resources\.bootstrap/);
assert.match(core, /function renderBookingSummary/);
assert.match(core, /function renderParticipantDetails/);
assert.match(core, /booking-summary-normalized/);
assert.match(core, /booking-received-summary/);
assert.match(core, /booking-member-meta/);
assert.match(core, /summaryMetaItem\('LINE 名稱'/);
assert.match(core, /summaryMetaItem\('會員編號'/);
assert.match(core, /summaryMetaItem\('總服務時間'/);
assert.match(core, /summaryMetaItem\('總金額'/);
assert.match(core, /booking-received-datetime/);
assert.match(core, /booking-received-name/);
assert.match(core, /booking-received-phone/);
assert.match(core, /booking-copy-button/);
assert.match(core, /逐位預約明細/);
assert.match(core, /預約項目：\$\{participantItemsLabel\(participant\.items\)\}/);
assert.match(core, /預約技師：\$\{techName\}/);
assert.match(core, /openParticipantItemsEditor/);
assert.match(core, /openParticipantTechnicianEditor/);
assert.match(core, /admin\.booking\.participants\.technicians\.update/);

assert.doesNotMatch(core, /legacyBookingFromCard/);
assert.doesNotMatch(core, /renderImmediateSummaries/);
assert.doesNotMatch(core, /booking-summary-provisional/);

const refresh = core.slice(core.indexOf('async function refreshAll'), core.indexOf('function publishOperationalBookingSnapshot'));
const hydrationBoundary = refresh.indexOf('const nextBooking = {');
assert.ok(hydrationBoundary > 0, 'refreshAll builds the normalized snapshot only after hydration');
assert.ok(refresh.indexOf("contactRequest('admin.booking.contacts'") < hydrationBoundary);
assert.ok(refresh.indexOf("groupDetailsRequest('admin.booking.group.details'") < hydrationBoundary);
assert.ok(refresh.indexOf("resourceRequest('admin.booking.resources.bootstrap'") < hydrationBoundary);
assert.doesNotMatch(refresh, /renderAll\(\)/);
assert.match(refresh, /if \(bookingDataChanged\) \{/);
assert.match(refresh, /renderBookings\(\)/);

assert.match(styles, /booking-received-summary/);
assert.match(styles, /booking-copy-button/);
assert.match(styles, /booking-summary-normalized/);
assert.match(styles, /booking-member-meta/);
assert.match(styles, /booking-member-meta-item/);
assert.match(styles, /min-height: 44px/);

console.log('admin booking single-renderer summary wiring OK');
