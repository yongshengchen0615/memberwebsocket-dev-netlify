const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = (path) => fs.readFileSync(path, 'utf8');

const adminFlow = read('MemberWebsocket-dev/admin/grant-automation.js');
const adminCalendarStyles = read('MemberWebsocket-dev/admin/calendar-responsive.css');
const userCalendar = read('MemberWebsocket-dev/calendar/app.js');
const calendarApi = read('MemberWebsocket-dev/supabase/functions/member-calendar-api/index.ts');
const edge = read('MemberWebsocket-dev/supabase/functions/grant-automation/index.ts');

assert.match(adminFlow, /EVENT_TICKET_CALENDAR_MANAGED/);
assert.match(adminFlow, /syncManagedEventTicketDeleteButton/);
assert.match(adminFlow, /decorateManagedEventTicketCalendarRows/);
assert.match(adminFlow, /handleManagedEventTicketCalendarClick/);
assert.match(adminFlow, /openManagedEventTicketInfo/);
assert.match(adminFlow, /eventTicketCalendarInfoModal/);
assert.match(adminFlow, /row\.querySelector\('\[data-admin-calendar-item-select\]'\)\?\.remove\(\)/);
assert.match(adminFlow, /grid\.addEventListener\('click', handleManagedEventTicketCalendarClick, true\)/);
assert.match(adminFlow, /grid\.addEventListener\('change', handleManagedEventTicketCalendarSelection, true\)/);
assert.match(adminFlow, /日曆中僅供查看/);
assert.match(adminFlow, /日曆中只能查看資訊/);
assert.match(adminFlow, /admin\.calendar-items\.save/);
assert.match(adminFlow, /不能批次修改或刪除/);
assert.match(adminFlow, /由活動票券管理/);
assert.match(adminFlow, /休假日不顯示活動，移除休假後會自動恢復/);
assert.doesNotMatch(adminFlow, /已自動取消加入日曆/);
assert.doesNotMatch(adminFlow, /saved\.calendarSync[\s\S]{0,160}reason === 'holiday'/);

assert.match(adminCalendarStyles, /admin-calendar-item-row\[data-event-ticket-calendar-managed="true"\][^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
assert.match(adminCalendarStyles, /#eventTicketCalendarInfoModal \.editor-modal-card/);
assert.match(adminCalendarStyles, /#calendarEditorModal,\s*#eventTicketCalendarInfoModal/);

assert.match(userCalendar, /openCalendarLinkInLine/);
assert.match(userCalendar, /window\.liff\.openWindow\(\{ url, external: false \}\)/);
assert.match(userCalendar, /event\.preventDefault\(\)/);
assert.match(userCalendar, /window\.location\.assign\(url\)/);
assert.doesNotMatch(userCalendar, /link\.target = '_blank'/);
assert.doesNotMatch(userCalendar, /link\.rel = 'noopener noreferrer'/);

assert.match(calendarApi, /splitManagedEventAroundHolidays/);
assert.match(calendarApi, /holidayDateSet/);
assert.match(calendarApi, /source.*event-ticket-calendar/);
assert.match(calendarApi, /applyCalendarDisplayRules/);
assert.match(calendarApi, /calendarDisplaySourceId/);
assert.doesNotMatch(edge, /findActiveHolidayOverlap/);
assert.doesNotMatch(edge, /removeManagedEventTicketCalendarItems/);
assert.doesNotMatch(edge, /event_ticket_holiday_overlap/);


assert.match(calendarApi, /if \(holidays\.has\(date\)\) \{[\s\S]*?pushSegment\(\)/);
assert.match(calendarApi, /items = applyCalendarDisplayRules\(items\)/);
assert.match(calendarApi, /if \(!parseIsoDate\(date\)\)/);
assert.match(calendarApi, /items = items\.filter\(\(item\) => includesDate\(item, date\)\)/);

console.log('event ticket calendar holiday/source/read-only guard OK');
