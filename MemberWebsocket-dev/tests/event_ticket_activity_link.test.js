const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = (path) => fs.readFileSync(path, 'utf8');

const adminHtml = read('MemberWebsocket-dev/admin/index.html');
const eventHtml = read('MemberWebsocket-dev/event/index.html');
const eventUI = read('MemberWebsocket-dev/event-ticket-ui.js');
const eventApp = read('MemberWebsocket-dev/event/app.js');
const calendarSync = read('MemberWebsocket-dev/admin/grant-automation.js');
const adminApp = read('MemberWebsocket-dev/admin/app.js');
const fixedTicketAdmin = read('MemberWebsocket-dev/admin/fixed-ticket-admin.js');

assert.equal(fs.existsSync('MemberWebsocket-dev/admin/event-ticket-activity-link.js'), false);
assert.equal(fs.existsSync('MemberWebsocket-dev/event/activity-link.js'), false);

for (const asset of [
  'fixed-ticket-admin-integration.js?v=fixed-ticket-sync-20260916-1',
  'fixed-ticket-calendar-option.js?v=fixed-ticket-calendar-20260917-4',
  'fixed-ticket-admin.js?v=qa-purge-sync-20261005-1',
]) assert.ok(adminHtml.includes(asset), asset);

assert.match(adminHtml, /<link rel="stylesheet" href="\.\/fixed-ticket-admin\.css\?v=[^"<>]+">/);
assert.ok(!adminHtml.includes('event-ticket-activity-link.js'));

assert.match(eventHtml, /<script src="\.\/app\.js\?v=[^"<>]+" defer><\/script>/);
assert.ok(!eventHtml.includes('batch-redemption.js'));
assert.ok(!eventHtml.includes('batch-redemption.css'));
assert.ok(!eventHtml.includes('activity-link.js'));
assert.ok(eventUI.includes("options.fixed ? '固定票券'"));
assert.ok(eventUI.includes("options.fixed ? '發放方式' : '限量張數'"));
assert.ok(eventApp.includes('eventTicketQuotaText(ticket)'));
assert.ok(eventUI.includes('系統自動發放'));
assert.ok(eventApp.includes('normalizeFixedOffers'));
assert.ok(eventApp.includes('autoOpenFromCalendar'));
assert.ok(eventApp.includes("source') !== 'event-ticket-calendar'"));

assert.ok(calendarSync.includes("url.searchParams.set('source', 'event-ticket-calendar')"));
assert.ok(calendarSync.includes("url.searchParams.set('eventTicketId'"));

console.log('event ticket fixed-ticket rendering is integrated into current entrypoints');

assert.ok(adminApp.includes("dataset.memberAdminReady = 'true'"));
assert.ok(adminApp.includes("new Event('member-admin-ready')"));
assert.ok(adminApp.includes("new Event('member-admin-event-ticket-list-rendered')"));
assert.ok(fixedTicketAdmin.includes("window.addEventListener('member-admin-ready', loadTemplates, { once: true })"));
assert.ok(fixedTicketAdmin.includes("window.addEventListener('member-admin-event-ticket-list-rendered', renderFixedList)"));
assert.ok(!fixedTicketAdmin.includes("new MutationObserver(() => {"));
assert.ok(!fixedTicketAdmin.includes("for (let attempt = 0; attempt < 80; attempt += 1)"));
