const {test,expect}=require('playwright/test');
const {startFixture,transport,today,version}=require('./admin-fixture.cjs');
let host;
test.beforeAll(async()=>{host=await startFixture();});
test.afterAll(async()=>host.close());
test.beforeEach(async({page},info)=>{
  const run=String(info.testId);const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.route('https://fixture.supabase.co/**',async route=>{
    if(route.request().url().includes('/storage/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="40">QA receipt</text></svg>'});
    const {action,operation,...payload}=route.request().postDataJSON();
    try {await route.fulfill({json:{ok:true,data:await transport(host.sessions.get(run),action||operation,payload,new URL(route.request().url()).pathname.split('/').at(-1))}});}
    catch(e){await route.fulfill({status:400,json:{ok:false,error:{code:e.code,message:e.message}}});}
  });
  await page.route('https://nominatim.openstreetmap.org/**',r=>r.fulfill({json:[{lat:'25.033',lon:'121.5654',display_name:'QA Taipei'}]}));
  // No real member, LINE message, map service or database is reachable.
  await page.route(/https?:\/\/(?!127\.0\.0\.1|fixture\.supabase\.co|nominatim\.openstreetmap\.org)/,r=>r.abort());
  await page.goto(host.base+'/admin/?run='+run);
  await expect(page.locator('#adminView')).toBeVisible();
  info.fixture=host.sessions.get(run);info.browserErrors=errors;
});
test.afterEach(async({page},info)=>{
  expect(info.fixture?.unexpected||[], 'All API actions must be modeled explicitly').toEqual([]);
  expect(info.browserErrors||[], 'No uncaught production UI errors').toEqual([]);
  if(typeof page.screenshot==='function' && /BOOKING_ACCESSIBLE|BOOKING_RELEASED_TICKET/.test(info.title)) await info.attach('admin-final-state',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  await info.attach('admin-interaction-evidence',{body:JSON.stringify({evidence:'chromium-isolated-transport',calls:info.fixture?.calls},null,2),contentType:'application/json'});
});
const click=(p,id)=>p.locator('#'+id).click();
const fill=(p,id,value)=>p.locator('#'+id).fill(String(value));
const select=(p,id,value)=>p.locator('#'+id).selectOption(String(value));
const calls=(s,a)=>s.calls.filter(c=>c.action===a);
async function openMember360(p){await p.locator('[data-action="view-records"]').first().click();await expect(p.locator('#memberRecordsModal')).toBeVisible();}
async function openMember(p){await click(p,'testMembersSubtab');await openMember360(p);await p.getByRole('button',{name:'狀態'}).click();await expect(p.locator('#memberModal')).toBeVisible();}
async function openCard(p){await click(p,'cardsTab');await click(p,'newCardButton');await fill(p,'cardTitle','QA new card');await select(p,'cardStatus','draft');await p.locator('#rewardRows [data-field="ticketTemplateId"]').selectOption('ticket-1');}
async function openEvent(p,type='coupon'){await click(p,'eventsTab');await click(p,'newEventTicketButton');await select(p,'eventTicketType',type);for(const [id,value] of Object.entries({eventTicketTitle:'QA event',eventTicketDescription:'QA description',eventTicketUsageMethod:'QA usage',eventTicketUsageInstructions:'QA instructions'}))await fill(p,id,value);await select(p,'eventTicketStatus','draft');}
async function openCalendar(p,type='event'){await click(p,'calendarTab');await click(p,'newCalendarItemButton');await fill(p,'calendarItemTitle','QA calendar');await select(p,'calendarItemType',type);await select(p,'calendarItemStatus','draft');await fill(p,'calendarItemStartsOn',today());}
async function booking(p,tab){await click(p,'bookingTab');await click(p,tab||'bookingAdminServicesSubtab');await expect(p.locator('#bookingAdminSyncStatus')).toContainText('已同步');}

test('MEMBER_DIRECTORY — real/test roster, search, empty result and both pagination directions',async({page:p},info)=>{
  await click(p,'testMembersSubtab');await expect(p.locator('#memberTableBody tr')).toHaveCount(2);
  await click(p,'memberNextPageButton');await expect(p.locator('#memberTableBody')).toContainText('TEST3');
  await click(p,'memberPrevPageButton');await expect(p.locator('#memberTableBody')).toContainText('TEST1');
  await fill(p,'memberSearch','TEST2');await expect(p.locator('#memberTableBody tr')).toHaveCount(1);await expect(p.locator('#memberTableBody')).toContainText('TEST2');
  await fill(p,'memberSearch','no-match');await expect(p.locator('#memberEmptyState')).toBeVisible();
  await fill(p,'memberSearch','');await click(p,'realMembersSubtab');expect(calls(info.fixture,'admin.members.list').some(c=>c.payload.memberKind==='real')).toBe(true);
});
test('MEMBER_PROFILE_STATUS — edit all test profile fields, disable, reopen and restore',async({page:p},info)=>{
  await openMember(p);await fill(p,'memberDisplayName','QA changed');await fill(p,'memberSurname','Chen');await select(p,'memberSalutation','ms');await fill(p,'memberBirthday','1990-02-03');await fill(p,'memberPhone','+886923456789');await select(p,'memberStatus','disabled');await click(p,'saveMemberButton');
  await expect(p.locator('#memberModal')).toBeHidden();await expect(p.locator('#memberRecordsModal')).toBeVisible();await p.getByRole('button',{name:'狀態'}).click();await expect(p.locator('#memberDisplayName')).toHaveValue('QA changed');await expect(p.locator('#memberStatus')).toHaveValue('disabled');
  await select(p,'memberStatus','active');await click(p,'saveMemberButton');await expect(p.locator('#memberModal')).toBeHidden();expect(calls(info.fixture,'admin.member.update')).toHaveLength(2);
});
test('MEMBER_360 — status and grant actions, then history workspace member selector and categories',async({page:p},info)=>{
  await openMember360(p);
  await expect(p.locator('#memberRecordsOverview')).toContainText('狀態');
  await expect(p.locator('#memberRecordsOverview')).toContainText('＋ 發放');
  await p.getByRole('button',{name:'狀態'}).click(); await expect(p.locator('#memberModal')).toBeVisible();
  await p.keyboard.press('Escape'); await expect(p.locator('#memberModal')).toBeHidden(); await expect(p.locator('#memberRecordsModal')).toBeVisible();
  await click(p,'memberRecordsOpenUsage');
  await expect(p.locator('#memberRecordsModal')).toBeHidden();
  await expect(p.locator('#memberUsagePanel')).toBeVisible();
  await expect(p.locator('#memberUsageSelect')).toBeEnabled();
  for(const filter of ['all','presence','pointCards','eventTickets','calendar','bookings','testAutomation']) {
    const b=p.locator('#memberUsagePanel [data-record-filter="'+filter+'"]');
    await b.click();
    await expect(b).toHaveAttribute('aria-selected','true');
  }
  await select(p,'memberUsageKind','test');
  await expect(p.locator('#memberUsageSelect')).toBeEnabled();
  await expect.poll(()=>calls(info.fixture,'admin.members.list').some(c=>c.payload.memberKind==='test')).toBe(true);
  const selectedMemberId=await p.locator('#memberUsageSelect').evaluate(el=>el.options[1]?.value||'');
  expect(selectedMemberId).not.toBe('');
  await select(p,'memberUsageSelect',selectedMemberId);
  await expect(p.locator('#memberUsageSelectedLabel')).toContainText('·');
});
test('MEMBER_FORCE_LOGOUT — click revokes only the selected member and refreshes presence',async({page:p},info)=>{
  await p.locator('[data-action="force-logout"]').first().click();await expect.poll(()=>calls(info.fixture,'admin.member.force-logout').length).toBe(1);expect(info.fixture.members[0].isOnline).toBe(false);expect(info.fixture.members[1].isOnline).toBe(true);
});
test('MEMBER_TIERS — edit threshold and style, save, reload and preview',async({page:p},info)=>{
  await click(p,'memberTierSettingsTab');await fill(p,'tierSilverMinutes','120');await select(p,'tierSilverStyle','ocean');await expect(p.locator('[data-tier-style-preview="silver"]')).toHaveAttribute('data-style','ocean');await click(p,'saveTierSettingsButton');
  await expect.poll(()=>calls(info.fixture,'admin.member-tiers.save').length).toBe(1);await p.reload();await click(p,'memberTierSettingsTab');await expect(p.locator('#tierSilverMinutes')).toHaveValue('120');await expect(p.locator('#tierSilverStyle')).toHaveValue('ocean');
});
test('MEMBER_TERMS — draft create, edit, activate and active version becomes readonly',async({page:p},info)=>{
  await click(p,'memberTermsTab');await click(p,'termsNewDraft');await fill(p,'termsVersion','QA-2');await fill(p,'termsTitle','QA new terms');await fill(p,'termsSummary','QA summary');await fill(p,'termsBody','QA complete terms');await fill(p,'termsEffectiveAt','2026-10-04T12:00');await p.locator('label.terms-policy-card:has(#termsReconsent)').click();expect(await p.evaluate(()=>document.getElementById('termsReconsent').checked)).toBe(true);await click(p,'termsSave');
  await expect(p.locator('#termsId')).not.toHaveValue('');await fill(p,'termsSummary','QA edited');await click(p,'termsSave');await expect.poll(()=>calls(info.fixture,'admin.terms.draft.save').length).toBe(2);
  await click(p,'termsActivate');await expect(p.locator('#termsActiveVersion')).toHaveText('QA-2');await expect(p.locator('#termsBody')).toBeDisabled();expect(info.fixture.terms.filter(t=>t.status==='active')).toHaveLength(1);
});
test('MEMBER_PRESET — create, select, modify and archive message preset',async({page:p},info)=>{
  await click(p,'manageGrantMessagesButton');await click(p,'newMessagePresetButton');await fill(p,'messagePresetTitle','QA preset');await fill(p,'messagePresetBody','QA message');await click(p,'saveMessagePresetButton');await expect(p.locator('#messagePresetId')).not.toHaveValue('');
  await fill(p,'messagePresetBody','QA edited');await select(p,'messagePresetStatus','archived');await click(p,'saveMessagePresetButton');await expect.poll(()=>info.fixture.messagePresets[0]?.status).toBe('archived');await click(p,'closeMessagePresetModal');
});
for(const mode of ['immediate','scheduled','none'])test('MEMBER_GRANT_'+mode+' — Member 360 grant, multiple cards, service time and notification mode submit',async({page:p},info)=>{
  await openMember360(p);await p.getByRole('button',{name:'＋ 發放'}).click();await expect(p.locator('#grantModal')).toBeVisible();await p.locator('#grantStampsEnabled').check();await p.locator('[data-grant-point-field="cardId"]').selectOption('card-1');await p.locator('[data-grant-point-field="amount"]').fill('3');await click(p,'addGrantPointButton');await p.locator('[data-grant-point-row]').nth(1).locator('select').selectOption('card-2');await p.locator('[data-grant-point-row]').nth(1).locator('input').fill('2');
  await p.locator('#grantServiceTimeEnabled').check();await fill(p,'grantServiceTimeMinutes','60');await p.locator('input[name="grantNotificationMode"][value="'+mode+'"]').check();if(mode==='scheduled')await fill(p,'grantNotificationScheduledAt','2099-01-01T10:00');await click(p,'saveGrantButton');
  await expect(p.locator('#grantModal')).toBeHidden();expect(info.fixture.grants).toHaveLength(1);expect(info.fixture.grants[0].points).toHaveLength(2);expect(info.fixture.grants[0].notificationMode).toBe(mode);
});
test('POINT_CARD — full editor, rewards, style, expiry, save, archive and delete',async({page:p},info)=>{
  await openCard(p);await select(p,'cardStyle','peach');await expect(p.locator('[data-point-card-style-preview]')).toHaveAttribute('data-style','peach');await select(p,'cardExpiryMode','date');await fill(p,'cardExpiresOn','2099-12-31');await fill(p,'cardUsageMethod','QA earn');await fill(p,'cardUsageInstructions','QA use');await fill(p,'cardBenefitDescription','QA benefit');
  await click(p,'addRewardButton');await p.locator('#rewardRows [data-reward-row]').nth(1).locator('select[data-field="ticketTemplateId"]').selectOption('ticket-1');await p.locator('#rewardRows [data-field="thresholdStamps"]').nth(1).fill('10');await p.locator('#rewardRows [data-reward-row]').nth(1).locator('[data-remove-reward]').click();await click(p,'saveCardButton');await expect(p.locator('#cardId')).not.toHaveValue('');
  const id=await p.locator('#cardId').inputValue();await click(p,'archiveCardButton');await expect(p.locator('#cardStatus')).toHaveValue('archived');await click(p,'deleteCardButton');await expect(p.locator('#cardId')).toHaveValue('');expect(info.fixture.cards.some(c=>c.cardId===id)).toBe(false);
});
test('POINT_SORT — move card, persist order and reload',async({page:p},info)=>{
  await click(p,'cardsTab');await p.locator('[data-card-sort-move="up"]').nth(1).click();await click(p,'saveCardSortButton');await expect.poll(()=>calls(info.fixture,'admin.pointcards.reorder').length).toBe(1);await p.reload();await click(p,'cardsTab');await expect(p.locator('#cardListItems .card-list-item').first()).toContainText('QA card 2');await p.locator('[data-card-sort-move="down"]').first().click();await click(p,'saveCardSortButton');await expect.poll(()=>calls(info.fixture,'admin.pointcards.reorder').length).toBe(2);await p.reload();await click(p,'cardsTab');await expect(p.locator('#cardListItems .card-list-item').first()).toContainText('QA card 1');
});
for(const scope of ['points','event'])for(const limit of [0,2,50])test('LIMIT_'+scope+'_'+limit+' — save and reload usage limit',async({page:p},info)=>{
  const points=scope==='points';await click(p,points?'cardsTab':'eventsTab');const input=points?'globalMaxTicketsPerRedemption':'eventMaxTicketsPerDay';const button=points?'saveGlobalTicketSettingButton':'saveEventTicketSettingButton';await fill(p,input,limit);await click(p,button);await expect.poll(()=>calls(info.fixture,'admin.settings.save').length).toBe(1);await p.reload();await click(p,points?'cardsTab':'eventsTab');await expect(p.locator('#'+input)).toHaveValue(String(limit));
});
for(const type of ['coupon','lottery'])test('POINT_TEMPLATE_'+type+' — create, edit, archive and reload',async({page:p},info)=>{
  await click(p,'cardsTab');await click(p,'ticketSettingsTab');await click(p,'newTicketButton');await fill(p,'ticketTitle','QA template');await select(p,'ticketType',type);await fill(p,'ticketDescription','QA description');await fill(p,'ticketUsageMethod','QA usage');await fill(p,'ticketUsageInstructions','QA instructions');await select(p,'ticketStatus','draft');
  if(type==='lottery'){await p.locator('#ticketPrizeRows [data-field="ticketPrizeTitle"]').first().fill('QA prize');}
  await click(p,'saveTicketButton');await expect(p.locator('#ticketTemplateId')).not.toHaveValue('');
  // The returned ID precedes the final bootstrap. Wait for the save to finish
  // before editing again so that readback cannot replace the next draft.
  await expect(p.locator('#saveTicketButton')).toBeEnabled();
  await select(p,'ticketStatus','archived');await click(p,'saveTicketButton');await expect.poll(()=>info.fixture.tickets.find(t=>t.title==='QA template')?.status).toBe('archived');
});
test('POINT_TEMPLATE_DELETE — referenced template is blocked and unreferenced template is deletable',async({page:p},info)=>{
  await click(p,'cardsTab');await click(p,'ticketSettingsTab');
  await p.locator('[data-ticket-template-id="ticket-1"]').first().click();
  await expect(p.locator('#deleteTicketButton')).toBeVisible();
  await click(p,'deleteTicketButton');
  await expect(p.locator('#ticketFormMessage')).toContainText('仍被集點卡兌換節點引用');
  expect(info.fixture.tickets.some(t=>t.ticketTemplateId==='ticket-1')).toBe(true);
  await p.locator('#ticketEditorModal .editor-modal-close').click();
  await expect(p.locator('#ticketEditorModal')).toBeHidden();
  await click(p,'newTicketButton');
  await expect(p.locator('#deleteTicketButton')).toBeHidden();
  await fill(p,'ticketTitle','QA deletable template');await fill(p,'ticketDescription','QA description');
  await fill(p,'ticketUsageMethod','QA usage');await fill(p,'ticketUsageInstructions','QA instructions');
  await select(p,'ticketStatus','draft');await click(p,'saveTicketButton');
  // Saving is asynchronous; ensure the server-generated template ID is in the form.
  await expect(p.locator('#ticketTemplateId')).not.toHaveValue('');
  const id=await p.locator('#ticketTemplateId').inputValue();
  await expect(p.locator('#deleteTicketButton')).toBeEnabled();
  await click(p,'deleteTicketButton');
  await expect(p.locator('#ticketTemplateId')).toHaveValue('');
  expect(info.fixture.tickets.some(t=>t.ticketTemplateId===id)).toBe(false);
  expect(calls(info.fixture,'admin.tickets.delete')).toHaveLength(2);
});
for(const type of ['coupon','referral','membership_join','lottery'])test('EVENT_'+type+' — audience, quota, date, create, edit and delete',async({page:p},info)=>{
  await openEvent(p,type);await p.locator('#eventTicketAllowedTiers [data-audience-preset="gold-plus"]').click();await fill(p,'eventTicketStartsOn',today());await fill(p,'eventTicketEndsOn','2099-12-31');await fill(p,'eventTicketQuota','10');
  if(type==='lottery')await p.locator('#eventTicketPrizeRows [data-field="eventTicketPrizeTitle"]').first().fill('QA prize');
  await click(p,'saveEventTicketButton');await expect(p.locator('#eventTicketId')).not.toHaveValue('');await fill(p,'eventTicketTitle','QA edited event');await select(p,'eventTicketStatus','archived');await click(p,'saveEventTicketButton');await expect.poll(()=>info.fixture.eventTickets[0]?.title).toBe('QA edited event');expect(info.fixture.eventTickets[0].allowedTierKeys).toEqual(['gold','platinum']);await click(p,'deleteEventTicketButton');await expect(p.locator('#eventTicketId')).toHaveValue('');expect(info.fixture.eventTickets).toHaveLength(0);
});
for(const [schedule,expiry] of [['birthday_month','month_end'],['weekly','week_end'],['monthly','days_after_issue'],['yearly','fixed_date']])test('FIXED_'+schedule+' — schedule, expiry, calendar, notify, save, run and delete',async({page:p},info)=>{
  await openEvent(p,'fixed');await select(p,'fixedTicketScheduleType',schedule);if(schedule==='yearly')await select(p,'fixedTicketScheduleMonth','12');if(['monthly','yearly'].includes(schedule))await fill(p,'fixedTicketScheduleDay','15');if(schedule==='weekly')await select(p,'fixedTicketScheduleWeekday','3');await select(p,'fixedTicketExpiryMode',expiry);if(expiry==='days_after_issue')await fill(p,'fixedTicketExpiryDays','14');if(expiry==='fixed_date')await fill(p,'fixedTicketExpiryDate','2099-12-31');await p.locator('#fixedTicketNotifyLine').uncheck();await p.locator('#fixedTicketCalendarEnabled').check();await click(p,'saveEventTicketButton');
  await expect.poll(()=>info.fixture.templates.length).toBe(1);expect(info.fixture.templates[0]).toMatchObject({scheduleType:schedule,expiryMode:expiry,notifyLine:false,calendarEnabled:true});await click(p,'fixedTicketRunButton');await expect.poll(()=>calls(info.fixture,'admin.fixed-tickets.run').length).toBe(1);await click(p,'deleteEventTicketButton');await expect.poll(()=>info.fixture.templates.length).toBe(0);await expect(p.locator('#saveEventTicketButton')).toBeEnabled();await p.locator('#eventTicketEditorModal .editor-modal-close').click();await click(p,'newEventTicketButton');await expect(p.locator('#saveEventTicketButton')).toBeEnabled();
});
test('CALENDAR_NAV — previous, next, today and date opens editor',async({page:p})=>{
  await click(p,'calendarTab');const title=await p.locator('#adminCalendarMonthTitle').textContent();await click(p,'adminCalendarNextMonthButton');await expect(p.locator('#adminCalendarMonthTitle')).not.toHaveText(title);await click(p,'adminCalendarPreviousMonthButton');await expect(p.locator('#adminCalendarMonthTitle')).toHaveText(title);await click(p,'adminCalendarPreviousMonthButton');await click(p,'adminCalendarTodayButton');await expect(p.locator('#adminCalendarMonthTitle')).toHaveText(title);await p.locator('[data-admin-calendar-date]').first().click();await expect(p.locator('#calendarEditorModal')).toBeVisible();
});
for(const type of ['holiday','event'])test('CALENDAR_'+type+' — create, date range, audience, link, edit and delete',async({page:p},info)=>{
  await openCalendar(p,type);await fill(p,'calendarItemEndsOn',today());if(type==='event'){await p.locator('#calendarItemAllowedTiers input[value="general"]').uncheck();await p.locator('#calendarItemAllowedTiers input[value="silver"]').uncheck();await fill(p,'calendarItemLinkLabel','QA link');await fill(p,'calendarItemLinkUrl','https://example.test/qa');}
  await click(p,'saveCalendarItemButton');await expect(p.locator('#calendarItemId')).not.toHaveValue('');await expect(p.locator('#saveCalendarItemButton')).toBeEnabled();await fill(p,'calendarItemTitle','QA calendar edited');await click(p,'saveCalendarItemButton');await expect.poll(()=>info.fixture.calendarItems[0]?.title).toBe('QA calendar edited');await click(p,'deleteCalendarItemButton');await expect(p.locator('#calendarItemId')).toHaveValue('');expect(info.fixture.calendarItems).toHaveLength(0);
});
test('INTEGRATION — each view, every notification/domain filter, search and refresh',async({page:p},info)=>{
  info.fixture.templates.push({fixedTicketId:'birthday-current',title:'QA birthday current',status:'active',scheduleType:'birthday_month',allowedTierKeys:['general'],notifyLine:true,updatedAt:'2026-10-05T00:00:00Z'});
  await click(p,'operationsHubTab');await expect(p.locator('#integrationMetricGrid article')).toHaveCount(6);
  await expect(p.locator('#integrationBirthday')).toContainText('QA birthday current');
  await expect(p.locator('#integrationBenefitSummary')).toContainText('生日固定票券');
  await expect(p.locator('#operationsHubPanel')).not.toContainText('生日舊規則');
  for(const view of ['benefits','notifications','audit','overview']){await p.locator('[data-integration-view-tab="'+view+'"]').click();await expect(p.locator('[data-integration-view="'+view+'"]')).toBeVisible();}
  await p.locator('[data-integration-view-tab="notifications"]').click();for(const filter of ['pending','sent','failed','all']){await select(p,'integrationNotificationFilter',filter);await expect(p.locator('#integrationNotifications tbody tr')).toHaveCount(filter==='all'?3:1);if(filter!=='all')await expect(p.locator('#integrationNotifications')).toContainText('QA '+filter);}
  await p.locator('[data-integration-view-tab="audit"]').click();for(const domain of ['member','booking','event_ticket','calendar','system','all']){await select(p,'integrationAuditFilter',domain);await expect(p.locator('#integrationAuditTimeline article')).toHaveCount(domain==='all'?5:1);}
  await fill(p,'integrationAuditSearch','Target booking');await expect(p.locator('#integrationAuditTimeline article')).toHaveCount(1);await fill(p,'integrationAuditSearch','absent');await expect(p.locator('#integrationAuditTimeline')).toContainText('沒有符合');await p.locator('[data-integration-action="refresh"]').click();await expect.poll(()=>calls(info.fixture,'admin.integration-overview').length).toBeGreaterThan(1);
});
for(const [target,expected] of [['member-grant','membersPanel'],['booking-services','bookingAdminServicesPanel'],['events','eventsPanel'],['booking-queue','bookingAdminQueuePanel'],['calendar-batch','calendarPanel'],['fixed-new','eventTicketEditorModal'],['birthday-fixed-new','eventTicketEditorModal']])test('INTEGRATION_NAV_'+target+' — opens the actual destination',async({page:p})=>{
  await click(p,'operationsHubTab');if(target.includes('fixed'))await p.locator('[data-integration-view-tab="benefits"]').click();await p.locator('[data-integration-target="'+target+'"]').first().click();await expect(p.locator('#'+expected)).toBeVisible();if(target==='birthday-fixed-new')await expect(p.locator('#fixedTicketScheduleType')).toHaveValue('birthday_month');
});

module.exports={booking,click,fill,select,openEvent,openCard,openCalendar};

test('CALENDAR_BATCH — select dates, add/remove rows, create, update and delete selected items',async({page:p},info)=>{
  await click(p,'calendarTab');const dates=p.locator('[data-admin-calendar-date-select]');await dates.nth(10).check();await dates.nth(11).check();await click(p,'addCalendarBatchItemButton');await expect(p.locator('[data-calendar-batch-row]')).toHaveCount(2);
  for(let i=0;i<2;i++){const row=p.locator('[data-calendar-batch-row]').nth(i);await row.locator('[data-calendar-batch-field="title"]').fill('QA batch '+i);await row.locator('[data-calendar-batch-field="status"]').selectOption('draft');}
  await click(p,'saveCalendarBatchButton');await expect.poll(()=>info.fixture.calendarItems.length).toBe(2);await expect(p.locator('[data-calendar-batch-row]')).toHaveCount(0);
  await p.locator('[data-admin-calendar-item-select]').first().check();await click(p,'queueSelectedCalendarItemsButton');await p.locator('[data-calendar-batch-field="title"]').fill('QA batch edited');await click(p,'saveCalendarBatchButton');await expect.poll(()=>info.fixture.calendarItems.some(x=>x.title==='QA batch edited')).toBe(true);
  for(const item of info.fixture.calendarItems)await p.locator('[data-admin-calendar-item-select="'+item.calendarItemId+'"]').first().check();await click(p,'deleteSelectedCalendarItemsButton');await expect.poll(()=>info.fixture.calendarItems.length).toBe(0);
});

test('BOOKING_TYPE — create, edit reward rule, reread and delete type',async({page:p},info)=>{
  await booking(p);await click(p,'bookingAdminNewTypeButton');await p.locator('[data-type-name]').fill('QA type');await p.locator('[data-type-reward-enabled]').check();await p.locator('[data-type-reward-minutes]').fill('30');await p.locator('[data-type-reward-card]').selectOption('card-1');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();
  const row=p.locator('#bookingAdminTypeList .booking-admin-service-row').filter({hasText:'QA type'});await row.getByRole('button',{name:'修改'}).click();await p.locator('[data-type-name]').fill('QA type edited');await p.locator('[data-type-reward-minutes]').fill('60');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();expect(info.fixture.serviceTypes.find(t=>t.name==='QA type edited')).toMatchObject({rewardMinutesPerPoint:60,rewardPointCardId:'card-1'});await p.locator('#bookingAdminTypeList .booking-admin-service-row').filter({hasText:'QA type edited'}).getByRole('button',{name:'刪除'}).click();await expect.poll(()=>info.fixture.serviceTypes.length).toBe(1);
});
async function fillService(row,title){await row.locator('[data-field="title"]').fill(title);await row.locator('[data-field="serviceType"]').selectOption('Body');await row.locator('[data-field="durationMinutes"]').fill('45');await row.locator('[data-field="priceAmount"]').fill('350');await row.locator('[data-field="requiresCompanionService"]').check();}

test('BOOKING_SERVICE — create, edit, add-on rule, price, always-open status and delete',async({page:p},info)=>{
  await booking(p);await click(p,'bookingAdminNewServiceButton');await fillService(p.locator('#bookingAdminCrudModal'),'QA created service');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();
  const row=p.locator('#bookingAdminServiceList .booking-admin-service-row').filter({hasText:'QA created service'});await row.getByRole('button',{name:'修改'}).click();await p.locator('[data-field="priceAmount"]').fill('500');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();expect(info.fixture.services.find(s=>s.title==='QA created service')).toMatchObject({priceAmount:500,requiresCompanionService:true,isActive:true});await row.getByRole('button',{name:'刪除'}).click();await expect.poll(()=>info.fixture.services.length).toBe(2);
});
test('BOOKING_SERVICE_BATCH — add/remove rows, persist batch, select, edit and delete',async({page:p},info)=>{
  await booking(p);await click(p,'bookingAdminBatchAddButton');await p.locator('[data-add-row]').click();await p.locator('[data-batch-row]').nth(2).getByRole('button',{name:'移除此列'}).click();await expect(p.locator('[data-batch-row]')).toHaveCount(2);
  for(let i=0;i<2;i++)await fillService(p.locator('[data-batch-row]').nth(i),'QA batch service '+i);await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();
  const selected=p.locator('#bookingAdminServiceList .booking-admin-service-row').filter({hasText:'QA batch service'});for(let i=0;i<2;i++)await selected.nth(i).locator('input[type="checkbox"]').check();await click(p,'bookingAdminBatchEditButton');await p.locator('[data-batch-row] [data-field="priceAmount"]').first().fill('450');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();for(let i=0;i<2;i++)await selected.nth(i).locator('input[type="checkbox"]').check();await click(p,'bookingAdminBatchDeleteButton');await expect.poll(()=>info.fixture.services.length).toBe(2);expect(calls(info.fixture,'admin.booking.services.batch')).toHaveLength(3);
});
test('BOOKING_TECHNICIAN — create, edit, disable, restore and primary protection',async({page:p},info)=>{
  await booking(p,'bookingAdminTechniciansSubtab');await expect(p.locator('.booking-admin-technician-row').filter({hasText:'QA primary'}).locator('[data-booking-admin-action="disable-technician"]')).toBeDisabled();await click(p,'bookingAdminNewTechnicianButton');await fill(p,'bookingAdminTechnicianName','QA added technician');await fill(p,'bookingAdminTechnicianSortOrder','10');await click(p,'bookingAdminSaveTechnicianButton');await expect(p.locator('#bookingAdminTechnicianModal')).toBeHidden();
  const row=p.locator('#bookingAdminTechnicianList .booking-admin-technician-row').filter({hasText:'QA added technician'});await row.locator('[data-booking-admin-action="edit-technician"]').click();await fill(p,'bookingAdminTechnicianName','QA edited technician');await click(p,'bookingAdminSaveTechnicianButton');await expect(p.locator('#bookingAdminTechnicianModal')).toBeHidden();
  await p.locator('#bookingAdminTechnicianList .booking-admin-technician-row').filter({hasText:'QA edited technician'}).getByRole('button',{name:'停用'}).click();await click(p,'bookingAdminTechnicianDisabledTab');await p.locator('#bookingAdminTechnicianList').getByRole('button',{name:'恢復公開'}).click();await click(p,'bookingAdminTechnicianActiveTab');await expect(p.locator('#bookingAdminTechnicianList')).toContainText('QA edited technician');expect(info.fixture.technicians.find(t=>t.name==='QA edited technician')?.isActive).toBe(true);
});
test('BOOKING_RESOURCE_SETTINGS — primary technician and party size save and reload',async({page:p},info)=>{
  await booking(p,'bookingAdminTechniciansSubtab');await fill(p,'bookingAdminMaxPartySize','3');await select(p,'bookingAdminPrimaryTechnician','tech-2');await click(p,'bookingAdminSavePartySizeButton');await expect.poll(()=>info.fixture.settings.primaryTechnicianId).toBe('tech-2');await click(p,'bookingAdminResourceRefreshButton');await expect(p.locator('#bookingAdminMaxPartySize')).toHaveValue('3');
  await expect(p.locator('#bookingAdminRequirePrimaryTechnician')).toBeChecked();
  await p.locator('#bookingAdminRequirePrimaryTechnician').uncheck();
  let releaseSettings;info.fixture.hold={action:'admin.booking.resources.settings.save',wait:new Promise(resolve=>{releaseSettings=resolve;})};
  await click(p,'bookingAdminSavePartySizeButton');
  try{await expect(p.locator('#bookingAdminResourceRefreshButton')).toBeDisabled();}finally{releaseSettings();}
  await expect(p.locator('#bookingAdminResourceRefreshButton')).toBeEnabled();await click(p,'bookingAdminResourceRefreshButton');
  await expect(p.locator('#bookingAdminRequirePrimaryTechnician')).not.toBeChecked();await expect(p.locator('#bookingAdminPrimaryTechnician')).toHaveValue('tech-2');
  await p.locator('#bookingAdminRequirePrimaryTechnician').uncheck();await select(p,'bookingAdminPrimaryTechnician','');await click(p,'bookingAdminSavePartySizeButton');
  await expect.poll(()=>info.fixture.settings.requirePrimaryTechnician).toBe(false);await click(p,'bookingAdminResourceRefreshButton');
  await expect(p.locator('#bookingAdminRequirePrimaryTechnician')).not.toBeChecked();await expect(p.locator('#bookingAdminPrimaryTechnician')).toHaveValue('');
  await p.locator('#bookingAdminRequirePrimaryTechnician').check();await click(p,'bookingAdminSavePartySizeButton');
  await expect(p.locator('#bookingAdminResourceMessage')).toContainText('請選擇主要技師');
  await select(p,'bookingAdminPrimaryTechnician','tech-1');await click(p,'bookingAdminSavePartySizeButton');await expect.poll(()=>info.fixture.settings.requirePrimaryTechnician).toBe(true);
});

test('FIXED_NOTIFICATION_TIME — Taipei time, off switch and persisted reload',async({page:p},info)=>{
  await openEvent(p,'fixed');await fill(p,'fixedTicketNotifyTime','09:30');await p.locator('#fixedTicketNotifyLine').uncheck();await click(p,'saveEventTicketButton');
  await expect.poll(()=>info.fixture.templates.length).toBe(1);expect(info.fixture.templates[0]).toMatchObject({notifyTime:'09:30',notifyLine:false});
  await p.locator('#eventTicketEditorModal .editor-modal-close').click();await expect(p.locator('#eventTicketEditorModal')).toBeHidden();
  await p.locator('#eventTicketListItems [data-fixed-ticket-id]').first().click();
  await expect(p.locator('#fixedTicketNotifyTime')).toHaveValue('09:30');await expect(p.locator('#fixedTicketNotifyLine')).not.toBeChecked();
  await fill(p,'fixedTicketNotifyTime','00:00');await p.locator('#fixedTicketNotifyLine').check();await click(p,'saveEventTicketButton');
  await expect.poll(()=>info.fixture.templates[0].notifyTime).toBe('00:00');expect(info.fixture.templates[0].notifyLine).toBe(true);
});
test('TICKET_BOOKING_POLICY_ENTRY — point and event views explain service-specific booking requirement',async({page:p})=>{
  await click(p,'cardsTab');await click(p,'ticketSettingsTab');
  await expect(p.locator('#ticketSettingsPanel .ticket-policy-entry')).toContainText('指定適用服務項目');
  await click(p,'eventsTab');
  await expect(p.locator('#eventsPanel .ticket-policy-entry')).toContainText('指定適用服務項目');
  await booking(p,'bookingAdminSettingsSubtab');
  await expect(p.locator('#bookingAdminTicketBookingRequired')).toHaveCount(0);
  await expect(p.locator('#bookingAdminSnapshotLocationRequired')).toBeVisible();
});
test('BOOKING_SHARED_SETTINGS — overnight hours, advance window, common time and reminder',async({page:p},info)=>{
  await booking(p,'bookingAdminSettingsSubtab');await fill(p,'bookingAdminStartTime','20:00');await fill(p,'bookingAdminEndTime','02:00');await fill(p,'bookingAdminSlotInterval','15');await fill(p,'bookingAdminAdvanceDays','1');await fill(p,'bookingAdminMaxAdvanceDays','30');await fill(p,'bookingAdminStoreServiceMinutes','15');await p.locator('#bookingAdminSnapshotLocationRequired').check();await p.evaluate(() => window.TicketLocationEditors.snapshot.set([{name:'QA 指定門市',latitude:25.033964,longitude:121.564468,radiusMeters:100}]));await p.locator('#bookingAdminReminderEnabled').check();await fill(p,'bookingAdminReminderTime','17:30');await fill(p,'bookingAdminNotice','QA line 1\nQA line 2');await click(p,'bookingAdminSaveSettingsButton');await expect.poll(()=>calls(info.fixture,'admin.booking.settings.save').length).toBe(1);await expect(p.locator('#bookingAdminSettingsMessage')).toContainText('儲存');expect(info.fixture.settings.workEndTime).toBe('02:00');expect(info.fixture.settings.snapshotLocationRequired).toBe(true);await p.reload();await booking(p,'bookingAdminSettingsSubtab');await expect(p.locator('#bookingAdminSnapshotLocationRequired')).toBeChecked();await p.locator('#bookingAdminSnapshotLocationRequired').uncheck();await click(p,'bookingAdminSaveSettingsButton');await expect.poll(()=>info.fixture.settings.snapshotLocationRequired).toBe(false);
});
function seedBooking(s,status='pending'){
  s.bookings=[{bookingId:'booking-1',memberId:'member-1',memberDisplayName:'QA booking member',contactSurname:'QA',contactSalutation:'mr',contactPhone:'+886912345678',memberCode:'TEST1',bookingDate:today(),startTime:'10:00',endTime:'10:30',status,totalDurationMinutes:30,updatedAt:version,createdAt:version,items:[{serviceId:'service-1',serviceTitle:'QA service',quantity:1,unitDurationMinutes:30,subtotalMinutes:30,serviceType:'Body'}],benefits:[]}];
}
for(const [initial,label,status] of [['pending','確認預約','confirmed'],['pending','不通過','rejected'],['confirmed','取消預約','cancelled'],['confirmed','確認服務完成','completed']])test('BOOKING_STATUS_'+status+' — UI transition, note and readback',async({page:p},info)=>{
  seedBooking(info.fixture,initial);await booking(p,'bookingAdminQueueSubtab');await p.locator('[data-booking-filter="'+initial+'"]').click();const row=p.locator('[data-booking-id="booking-1"]');await row.locator('textarea').fill('QA admin note');await row.getByRole('button',{name:label}).click();if(status==='completed'){await expect(p.locator('#bookingAdminCrudModal')).toContainText('30 分鐘');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();}await expect.poll(()=>info.fixture.bookings[0].status).toBe(status);await p.locator('[data-booking-filter="all"]').click();await expect(p.locator('#bookingAdminQueue')).toContainText('QA booking member');
});
for(const mode of ['register','dismiss'])test('BOOKING_ACCESSIBLE_'+mode+' — receipt review, submit, history and filters',async({page:p},info)=>{
  const receipt={receiptId:'receipt-1',memberId:'member-1',memberName:'QA Member',memberCode:'TEST1',createdAt:version,updatedAt:version,status:'awaiting_review',reviewStatus:'pending'};info.fixture.submissions=[receipt];info.fixture.accessibleRecords=[receipt];await booking(p,'bookingAdminQueueSubtab');await click(p,'bookingAdminAccessibleMode');await p.locator('#accessibleAdminQueueList button').click();await expect(p.locator('#accessibleAdminModal')).toBeVisible();
  if(mode==='dismiss')await click(p,'accessibleAdminDismiss');else{await p.locator('[data-service-check]').first().check();await p.locator('[data-minutes]').first().fill('60');await fill(p,'accessibleAdminDate',today());await fill(p,'accessibleAdminTime','10:03');await fill(p,'accessibleAdminNote','QA review');await click(p,'accessibleAdminSubmit');}
  await expect(p.locator('#accessibleAdminModal')).toBeHidden();expect(calls(info.fixture,'admin.booking.receipt.'+mode)).toHaveLength(1);
  if(mode==='register'){await expect(p.locator('#accessibleAdminQueueList')).toContainText('60 分鐘');await p.locator('#accessibleAdminQueueList button').click();await expect(p.locator('#accessibleAdminRecordStats')).toContainText('60 分鐘');await click(p,'accessibleAdminRecordClose');}
  for(const f of ['pending','completed','all']){await p.locator('[data-accessible-filter="'+f+'"]').click();await expect(p.locator('[data-accessible-filter="'+f+'"]').first()).toHaveAttribute('aria-selected','true');}
});

for(const code of ['CONFLICT','API_RESPONSE_UNCERTAIN','ADMIN_FORBIDDEN'])test('WRITE_FAILURE_'+code+' — denied card save cannot look successful or erase input',async({page:p},info)=>{
  await openCard(p);info.fixture.fault={action:'admin.pointcards.save',code};await click(p,'saveCardButton');await expect(p.locator('#cardFormMessage')).toBeVisible();await expect(p.locator('#cardTitle')).toHaveValue('QA new card');expect(info.fixture.cards).toHaveLength(2);await expect(p.locator('#cardId')).toHaveValue('');if(code==='API_RESPONSE_UNCERTAIN')await expect(p.locator('#saveCardButton')).toBeDisabled();else await expect(p.locator('#saveCardButton')).toBeEnabled();
});
test('INVALID_EDITORS — required titles, duplicate thresholds, date ranges and unsafe URLs never write',async({page:p},info)=>{
  await openCard(p);await fill(p,'cardTitle','');await click(p,'saveCardButton');await expect(p.locator('#cardFormMessage')).toBeVisible();expect(calls(info.fixture,'admin.pointcards.save')).toHaveLength(0);await fill(p,'cardTitle','QA invalid duplicate');await click(p,'addRewardButton');await p.locator('#rewardRows [data-field="ticketTemplateId"]').nth(1).selectOption('ticket-1');await p.locator('#rewardRows [data-field="thresholdStamps"]').nth(1).fill('5');await click(p,'saveCardButton');await expect(p.locator('#cardFormMessage')).toContainText('每個點數');expect(calls(info.fixture,'admin.pointcards.save')).toHaveLength(0);await p.locator('#cardEditorModal .editor-modal-close').click();
  await openEvent(p);await fill(p,'eventTicketStartsOn','2099-02-02');await fill(p,'eventTicketEndsOn','2099-01-01');await click(p,'saveEventTicketButton');await expect(p.locator('#eventTicketFormMessage')).toBeVisible();expect(calls(info.fixture,'admin.event-tickets.save')).toHaveLength(0);await p.locator('#eventTicketEditorModal .editor-modal-close').click();
  await openCalendar(p);await fill(p,'calendarItemLinkLabel','QA');await fill(p,'calendarItemLinkUrl','javascript:alert(1)');await click(p,'saveCalendarItemButton');await expect(p.locator('#calendarItemFormMessage')).toContainText('HTTPS');expect(calls(info.fixture,'admin.calendar-items.save')).toHaveLength(0);
});

for(const scope of ['template','event'])test('LOCATION_'+scope+' — search, select, rename, radius, adjust, clear, remove and persist',async({page:p},info)=>{
  const event=scope==='event',prefix=event?'eventTicket':'ticket';
  if(event)await openEvent(p);else{await click(p,'cardsTab');await click(p,'ticketSettingsTab');await click(p,'newTicketButton');await fill(p,'ticketTitle','QA GPS template');await select(p,'ticketStatus','draft');for(const id of ['ticketDescription','ticketUsageMethod','ticketUsageInstructions'])await fill(p,id,'QA required');}
  await p.locator('#'+prefix+'RequiresLocation').check();await fill(p,prefix+'AddressSearch','QA Taipei');await click(p,prefix+'AddressSearchButton');await p.locator('#'+prefix+'AddressResults button').first().click();await fill(p,prefix+'LocationDraftName','QA first location');await fill(p,prefix+'LocationDraftRadius','200');await click(p,event?'addEventTicketLocationButton':'addTicketLocationButton');
  const row=p.locator('#'+prefix+'LocationRows .coupon-location-row');await expect(row).toHaveCount(1);await row.getByRole('button',{name:'查看範圍',exact:true}).click();await row.getByRole('button',{name:'調整位置／範圍'}).click();await fill(p,prefix+'LocationDraftRadius','300');await click(p,event?'addEventTicketLocationButton':'addTicketLocationButton');await row.locator('input[type="text"]').fill('QA saved location');
  let releaseLocation;if(!event)info.fixture.hold={action:'admin.tickets.save',wait:new Promise(resolve=>{releaseLocation=resolve;})};
  await click(p,event?'saveEventTicketButton':'saveTicketButton');
  if(!event){try{await expect(p.locator('#ticketForm')).toHaveAttribute('inert','');}finally{releaseLocation();}}
  const saved=()=>event?info.fixture.eventTickets[0]:info.fixture.tickets.find(t=>t.title==='QA GPS template');await expect.poll(()=>saved()?.redemptionLocations?.[0]?.radiusMeters).toBe(300);expect(saved().requiresLocation).toBe(true);await row.getByRole('button',{name:'調整位置／範圍'}).click();await click(p,event?'clearEventTicketLocationDraftButton':'clearTicketLocationDraftButton');await expect(p.locator('#'+prefix+'LocationDraft')).toBeHidden();await row.getByRole('button',{name:'刪除',exact:true}).click();await expect(row).toHaveCount(0);await p.locator('#'+prefix+'RequiresLocation').uncheck();await click(p,event?'saveEventTicketButton':'saveTicketButton');await expect.poll(()=>saved()?.requiresLocation).toBe(false);
});
for(const scope of ['template','event'])test('LOTTERY_EDITOR_'+scope+' — add/delete prizes, reject invalid total and evenly balance',async({page:p},info)=>{
  const event=scope==='event',prefix=event?'eventTicket':'ticket',cap=event?'EventTicket':'Ticket';
  if(event)await openEvent(p,'lottery');else{await click(p,'cardsTab');await click(p,'ticketSettingsTab');await click(p,'newTicketButton');await fill(p,'ticketTitle','QA lottery');await select(p,'ticketType','lottery');await select(p,'ticketStatus','draft');for(const id of ['ticketDescription','ticketUsageMethod','ticketUsageInstructions'])await fill(p,id,'QA required');}
  await p.locator('#'+prefix+'PrizeRows [data-field="'+prefix+'PrizeTitle"]').fill('Prize A');await click(p,'add'+cap+'PrizeButton');await p.locator('#'+prefix+'PrizeRows [data-field="'+prefix+'PrizeTitle"]').nth(1).fill('Prize B');await p.locator('#'+prefix+'PrizeRows [data-field="'+prefix+'PrizeRate"]').first().fill('30');await click(p,'save'+cap+'Button');await expect(p.locator('#'+prefix+'FormMessage')).toBeVisible();expect(calls(info.fixture,event?'admin.event-tickets.save':'admin.tickets.save')).toHaveLength(0);
  await click(p,'balance'+cap+'PrizesButton');await expect(p.locator('#'+prefix+'PrizeTotal')).toContainText('100%');
  let releaseTicket;if(!event)info.fixture.hold={action:'admin.tickets.save',wait:new Promise(resolve=>{releaseTicket=resolve;})};
  await click(p,'save'+cap+'Button');
  if(!event){try{await expect(p.locator('#ticketPrizeRows [data-remove-ticket-prize]').nth(1)).toBeDisabled();}finally{releaseTicket();}await expect(p.locator('#saveTicketButton')).toBeEnabled();}
  await expect.poll(()=>calls(info.fixture,event?'admin.event-tickets.save':'admin.tickets.save').length).toBe(1);await p.locator('#'+prefix+'PrizeRows [data-remove-'+(event?'event-ticket':'ticket')+'-prize]').nth(1).click();await expect(p.locator('#'+prefix+'PrizeRows > div')).toHaveCount(1);await click(p,'balance'+cap+'PrizesButton');
});
for(const mode of ['any','all'])test('SERVICE_RULE_'+mode+' — save concrete service restrictions on reward and event',async({page:p},info)=>{
  await openCard(p);const row=p.locator('#rewardRows [data-reward-row]');await row.locator('[data-field="requiredServiceMatchMode"]').selectOption(mode);await row.locator('input[value="service-1"]').check();await click(p,'saveCardButton');await expect.poll(()=>info.fixture.cards.find(c=>c.title==='QA new card')?.rewards[0]?.requiredServiceMatchMode).toBe(mode);expect(info.fixture.cards.find(c=>c.title==='QA new card').rewards[0].requiredServiceIds).toEqual(['service-1']);await p.locator('#cardEditorModal .editor-modal-close').click();
  await openEvent(p);await select(p,'eventTicketRequiredServiceMatchMode',mode);await p.locator('#eventTicketRequiredServiceIds input[value="service-2"]').check();await click(p,'saveEventTicketButton');await expect.poll(()=>info.fixture.eventTickets[0]?.requiredServiceMatchMode).toBe(mode);expect(info.fixture.eventTickets[0].requiredServiceIds).toEqual(['service-2']);
});
test('BOOKING_ITEMS — reject empty selection, change quantities, save and reopen',async({page:p},info)=>{
  seedBooking(info.fixture);await booking(p,'bookingAdminQueueSubtab');await p.locator('[data-booking-id="booking-1"]').getByRole('button',{name:'修改服務項目'}).click();await p.locator('[data-booking-service="service-1"]').uncheck();await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('[data-modal-message]')).toContainText('至少');expect(calls(info.fixture,'admin.booking.items.update')).toHaveLength(0);await p.locator('[data-booking-service="service-2"]').check();await p.locator('[data-booking-quantity="service-2"]').selectOption('2');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();await p.locator('[data-booking-id="booking-1"]').getByRole('button',{name:'修改服務項目'}).click();await expect(p.locator('[data-booking-quantity="service-2"]')).toHaveValue('2');expect(info.fixture.bookings[0].startTime).toBe('10:00');
});
test('BOOKING_BENEFITS — owned points/event select, limit refusal, save, reopen and remove',async({page:p},info)=>{
  seedBooking(info.fixture);info.fixture.benefitCatalog={pointTicketMaxPerRedemption:1,eventTicketMaxPerDay:1,items:[{kind:'points',id:'p1',selectionId:'p1',selectable:true,title:'QA points 1',cardId:'card-1',pointCost:1,pointBalance:5},{kind:'points',id:'p2',selectionId:'p2',selectable:true,title:'QA points 2',cardId:'card-1',pointCost:1,pointBalance:5},{kind:'event',id:'e1',selectionId:'e1',selectable:true,title:'QA owned event'},{kind:'event',id:'offer',selectionId:'',selectable:true,title:'QA unclaimed offer'}]};
  await booking(p,'bookingAdminQueueSubtab');const edit=p.locator('[data-booking-id="booking-1"]').getByRole('button',{name:'修改預約票券'});await edit.click();await p.locator('[data-booking-benefit-id="p1"]').check();await p.locator('[data-booking-benefit-id="p2"]').check();await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('[data-modal-message]')).toContainText('最多');expect(calls(info.fixture,'admin.booking.benefits.update')).toHaveLength(0);await p.locator('[data-booking-benefit-id="p2"]').uncheck();await p.locator('[data-booking-benefit-id="e1"]').check();await expect(p.locator('[data-booking-benefit-rows] label').filter({hasText:'QA unclaimed offer'}).locator('input')).toBeDisabled();await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();expect(info.fixture.bookings[0].benefits).toHaveLength(2);await edit.click();await p.locator('[data-booking-benefit-id="p1"]').uncheck();await p.locator('[data-booking-benefit-id="e1"]').uncheck();await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect.poll(()=>info.fixture.bookings[0].benefits.length).toBe(0);
});
test('BOOKING_PARTICIPANTS — per-person items and technician edits with duplicate/primary validation',async({page:p},info)=>{
  seedBooking(info.fixture);info.fixture.groups['booking-1']={partySize:2,participants:[{position:1,technicianId:'tech-1',technicianName:'QA primary',items:info.fixture.bookings[0].items},{position:2,technicianId:'tech-2',technicianName:'QA secondary',items:info.fixture.bookings[0].items}]};
  await booking(p,'bookingAdminQueueSubtab');await p.locator('#bookingAdminQueue').getByRole('button',{name:'修改此位項目'}).nth(1).click();await p.locator('[data-participant-item-rows] input[value="service-2"]').check();await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();expect(info.fixture.groups['booking-1'].participants[1].items).toHaveLength(2);
  await p.locator('#bookingAdminQueue').getByRole('button',{name:'修改此位技師'}).nth(1).click();await p.locator('[data-participant-technician]').selectOption('tech-1');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('[data-modal-message]')).toContainText('不可重複');await p.locator('[data-participant-technician]').selectOption('');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();expect(info.fixture.groups['booking-1'].participants[1].technicianId).toBe('');
  await p.locator('#bookingAdminQueue').getByRole('button',{name:'修改此位技師'}).first().click();await p.locator('[data-participant-technician]').selectOption('');await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('[data-modal-message]')).toContainText('主要技師');
});
for(const action of ['approve','reject'])test('BOOKING_CANCELLATION_'+action+' — review request and verify resulting queue',async({page:p},info)=>{
  seedBooking(info.fixture,'confirmed');info.fixture.bookings[0].cancellationRequestedAt=version;await booking(p,'bookingAdminQueueSubtab');await p.locator('[data-booking-filter="confirmed"]').click();await expect(p.locator('#bookingAdminQueue')).toContainText('取消申請');await expect(p.locator('#bookingAdminQueue').getByRole('button',{name:'修改預約票券'})).toHaveCount(0);await click(p,'bookingCancellationRequestFilter');await p.locator('[data-booking-admin-action="'+action+'-cancellation"]').click();await expect.poll(()=>calls(info.fixture,'admin.'+action).length).toBe(1);expect(info.fixture.bookings[0].status).toBe(action==='approve'?'cancelled':'confirmed');await expect(p.locator('#bookingCancellationReviewEmpty')).toBeVisible();
});
test('BOOKING_RECEIPT — open signed receipt, inspect summary, close and clear URL',async({page:p},info)=>{
  seedBooking(info.fixture);info.fixture.receipts=[{receiptId:'r1',bookingId:'booking-1',status:'bound',boundAt:version}];await booking(p,'bookingAdminQueueSubtab');await p.locator('[data-admin-booking-receipt-control]').click();await expect(p.locator('#adminBookingReceiptModal')).toBeVisible();await expect(p.locator('#adminBookingReceiptImage')).toHaveAttribute('src','https://fixture.supabase.co/storage/v1/object/sign/booking-receipts/qa.svg?token=fixture');await click(p,'adminBookingReceiptClose');await expect(p.locator('#adminBookingReceiptModal')).toBeHidden();expect(calls(info.fixture,'admin.booking.receipt.url')).toHaveLength(1);await expect(p.locator('#adminBookingReceiptImage')).not.toHaveAttribute('src','https://fixture.supabase.co/storage/v1/object/sign/booking-receipts/qa.svg?token=fixture');
});

// Execute the registered production runner nodes, not copies of their logic.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const runtimeKeys=['ADMIN_MEMBER_DIRECTORY_CONTROLS','ADMIN_MEMBER_USAGE_LOGS','ADMIN_OPERATION_AUDIT','ADMIN_BOOKING_NO_SHOW_CONTROLS','ADMIN_MEMBER_MODALS','ADMIN_TEST_MEMBER_PROFILE_EDIT','ADMIN_GRANT_NOTIFICATION_CONTROLS','ADMIN_SERVICE_GRANT_JOURNEY','ADMIN_SETTINGS_COPY_CONTROLS','ADMIN_CALENDAR_EVENT_CRUD','ADMIN_EVENT_CALENDAR_SYNC','ADMIN_TIER_EDITOR_JOURNEY','ADMIN_TERMS_EDITOR_JOURNEY','ADMIN_CARD_EDITOR_OPTIONS','ADMIN_CARD_SORT_JOURNEY','ADMIN_EVENT_AUDIENCE_JOURNEY','ADMIN_CALENDAR_NAVIGATION','ADMIN_BOOKING_BATCH_EDITOR','ADMIN_CALENDAR_BATCH_CONTROLS','ADMIN_CALENDAR_CRUD','ADMIN_FIXED_DRAFT_BIRTHDAY_MONTH','ADMIN_FIXED_DRAFT_WEEKLY','ADMIN_FIXED_DRAFT_MONTHLY','ADMIN_FIXED_DRAFT_YEARLY'];
async function loadRuntime(p){
  await p.evaluate(fs.readFileSync(path.join(root,'e2e-scenario-graph.js'),'utf8'));
  await p.evaluate(fs.readFileSync(path.join(root,'admin/e2e-control.js'),'utf8').replace('  window.MemberAdminE2EControl =','  window.qaRuntime={adminDefinitions,state};\n  window.MemberAdminE2EControl ='));
  await p.evaluate(()=>{window.qaRuntime.state.adminTestAccount={memberId:'member-1',memberCode:'TEST1',lineUserId:'test:member-1'};const s=window.MemberAdminSession.get();window.MemberAdminSession.establish({...s.config,supabaseUrl:'https://fixture.supabase.co'},s.idToken);});
}
for(const key of runtimeKeys)test('RUNNER_'+key+' — production node executes against actual admin handlers',async({page:p},info)=>{
  info.setTimeout(45000);
  await loadRuntime(p);
  const result=await p.evaluate(async key=>{const node=window.qaRuntime.adminDefinitions('full',['member','points','event','calendar','integration','booking']).find(n=>n.key===key);return node.run();},key);
  expect(result.status,JSON.stringify(result)).toBe('passed');
  if(['ADMIN_MEMBER_MODALS','ADMIN_TEST_MEMBER_PROFILE_EDIT','ADMIN_GRANT_NOTIFICATION_CONTROLS','ADMIN_SERVICE_GRANT_JOURNEY'].includes(key)){for(const id of ['memberModal','grantModal','memberRecordsModal'])await expect(p.locator('#'+id)).toBeHidden();}
  if(key.includes('FIXED_DRAFT')){expect(info.fixture.templates).toHaveLength(0);expect(calls(info.fixture,'admin.fixed-tickets.run')).toHaveLength(0);expect(calls(info.fixture,'admin.fixed-tickets.save').every(c=>c.payload.template.status==='draft'&&!c.payload.template.notifyLine&&!c.payload.template.calendarEnabled)).toBe(true);}
});

test('RUNNER_MEMBER_MODAL_FAILURE — failed 360 load closes parent and performs no writes',async({page:p},info)=>{
  info.setTimeout(45000);await loadRuntime(p);info.fixture.fault={action:'admin.member-records.list',code:'RECORDS_UNAVAILABLE'};
  const error=await p.evaluate(async()=>{try{await qaRuntime.adminDefinitions('full',['member']).find(n=>n.key==='ADMIN_MEMBER_MODALS').run();return '';}catch(e){return e.message;}});
  expect(error).toContain('會員 360 尚未載入操作');
  for(const id of ['memberModal','grantModal','memberRecordsModal'])await expect(p.locator('#'+id)).toBeHidden();
  expect(calls(info.fixture,'admin.member.update')).toHaveLength(0);expect(info.fixture.grants).toHaveLength(0);
});

test('CALENDAR_BONUS — save bonus amount, reopen, disable by changing to holiday',async({page:p},info)=>{
  await openCalendar(p);await p.locator('#calendarBonusPointsEnabled').check();await fill(p,'calendarBonusPoints','4');await click(p,'saveCalendarItemButton');await expect.poll(()=>info.fixture.calendarItems[0]?.bonusPoints).toBe(4);const id=await p.locator('#calendarItemId').inputValue();await p.locator('#calendarEditorModal .editor-modal-close').click();await p.locator('[data-admin-calendar-item-id="'+id+'"]').first().click();await expect(p.locator('#calendarBonusPoints')).toHaveValue('4');await select(p,'calendarItemType','holiday');await expect(p.locator('#calendarBonusPointsField')).toBeHidden();await expect(p.locator('#calendarBonusPointsEnabled')).toBeDisabled();await click(p,'saveCalendarItemButton');await expect.poll(()=>info.fixture.calendarItems[0]?.bonusPointsEnabled).toBe(false);
});
test('EVENT_CALENDAR_SYNC — date required, add, readonly calendar detail and remove linkage',async({page:p},info)=>{
  await openEvent(p);await p.locator('#eventTicketAddToCalendar').check();await click(p,'saveEventTicketButton');await expect(p.locator('#eventTicketFormMessage')).toContainText('開始日');expect(info.fixture.eventTickets).toHaveLength(0);await fill(p,'eventTicketStartsOn',today());await click(p,'saveEventTicketButton');await expect.poll(()=>info.fixture.calendarItems.length).toBe(1);const ticketId=await p.locator('#eventTicketId').inputValue();const calendarId=info.fixture.calendarItems[0].calendarItemId;await p.locator('#eventTicketEditorModal .editor-modal-close').click();await click(p,'calendarTab');await p.locator('[data-admin-calendar-item-id="'+calendarId+'"]').first().click();await expect(p.locator('#eventTicketCalendarInfoModal')).toBeVisible();await expect(p.locator('#eventTicketCalendarInfoContent')).toContainText('活動票券同步');await expect(p.locator('#calendarEditorModal')).toBeHidden();await click(p,'closeEventTicketCalendarInfoButton');await click(p,'eventsTab');await p.locator('[data-event-ticket-id="'+ticketId+'"]').first().click();await expect(p.locator('#eventTicketAddToCalendar')).toBeEnabled();await p.locator('#eventTicketAddToCalendar').uncheck();await click(p,'saveEventTicketButton');await expect.poll(()=>info.fixture.calendarItems.length).toBe(0);
});
test('MEMBER_MESSAGE_SELECTION — preset list selection, grant preview and payload',async({page:p},info)=>{
  // This is still a synthetic in-memory member; exercise the non-test UI branch.
  info.fixture.members[0].isTestAccount=false;info.fixture.messagePresets=[{presetId:'preset-qa',title:'QA preset',message:'QA preview message',status:'active',updatedAt:version}];await p.reload();await click(p,'manageGrantMessagesButton');await select(p,'messagePresetList','preset-qa');await expect(p.locator('#messagePresetBody')).toHaveValue('QA preview message');await click(p,'closeMessagePresetModal');await openMember360(p);await p.getByRole('button',{name:'＋ 發放'}).click();await expect(p.locator('#grantModal')).toBeVisible();await select(p,'grantMessagePreset','preset-qa');await expect(p.locator('#grantMessagePreview')).toContainText('QA preview message');await p.locator('#grantServiceTimeEnabled').check();await fill(p,'grantServiceTimeMinutes','15');await click(p,'saveGrantButton');await expect(p.locator('#grantModal')).toBeHidden();expect(info.fixture.grants[0].messagePresetId).toBe('preset-qa');
});
test('POINT_DRAG — pointer drag sorting, save and readback',async({page:p},info)=>{
  await click(p,'cardsTab');await p.locator('[data-card-sort-item][data-card-id="card-2"]').dragTo(p.locator('[data-card-sort-item][data-card-id="card-1"]'));await expect(p.locator('#saveCardSortButton')).toBeEnabled();await click(p,'saveCardSortButton');await expect.poll(()=>info.fixture.cards[0].cardId).toBe('card-2');
});
test('BOOKING_COPY — copy complete booking details through the UI',async({page:p},info)=>{
  seedBooking(info.fixture);await booking(p,'bookingAdminQueueSubtab');await p.locator('#bookingAdminQueue [data-booking-admin-action="copy-booking"]').click();const text=await p.evaluate(()=>navigator.clipboard.readText());expect(text).toContain('QA先生');expect(text).toContain('QA service');expect(text).toContain('10:00');
});

for(const [key,action] of [['ADMIN_CALENDAR_CRUD','admin.calendar-items.save'],['ADMIN_FIXED_DRAFT_WEEKLY','admin.fixed-tickets.save']])test('RUNNER_REJECTED_'+key+' — rejected update fails evidence and cleans only owned QA draft',async({page:p},info)=>{
  info.setTimeout(45000);await loadRuntime(p);info.fixture.fault={action,code:'CONFLICT',onCall:2};
  const result=await p.evaluate(async key=>window.qaRuntime.adminDefinitions('full',['member','points','event','calendar','integration','booking']).find(n=>n.key===key).run(),key);
  expect(result.status,JSON.stringify(result)).toBe('failed');expect(result.actual.updated).toBe(false);expect(info.fixture.calendarItems).toHaveLength(0);expect(info.fixture.templates).toHaveLength(0);expect(info.fixture.cards).toHaveLength(2);
});

async function seedAccessible(p,s){const r={receiptId:'receipt-qa',memberId:'member-1',memberName:'QA Member',memberCode:'TEST1',status:'awaiting_review',reviewStatus:'pending',createdAt:version,updatedAt:version};s.submissions=[r];s.accessibleRecords=[r];await booking(p,'bookingAdminQueueSubtab');await click(p,'bookingAdminAccessibleMode');await p.locator('#accessibleAdminQueueList button').click();await expect(p.locator('#accessibleAdminModal')).toBeVisible();}
test('BOOKING_ACCESSIBLE_BENEFITS — owned tickets, concrete services, shared point budget and review payload',async({page:p},info)=>{
  info.fixture.benefitCatalog={pointTicketMaxPerRedemption:0,eventTicketMaxPerDay:1,items:[{kind:'points',selectionId:'p1',id:'p1',selectable:true,title:'QA points A',cardId:'card-1',pointCost:3,pointBalance:5,requiredServiceIds:['service-1']},{kind:'points',selectionId:'p2',id:'p2',selectable:true,title:'QA points B',cardId:'card-1',pointCost:3,pointBalance:5},{kind:'event',selectionId:'e1',id:'e1',selectable:true,title:'QA owned event'},{kind:'event',selectionId:'',id:'offer',selectable:true,title:'QA unclaimed'}]};
  await seedAccessible(p,info.fixture);await fill(p,'accessibleAdminDate',today());await fill(p,'accessibleAdminTime','10:03');await p.locator('[data-service-check]').first().check();await p.locator('[data-benefit-check][data-selection-id="p1"]').check();await expect(p.locator('[data-benefit-check][data-selection-id="p2"]')).toBeDisabled();await p.locator('[data-benefit-check][data-selection-id="p1"]').uncheck();await expect(p.locator('[data-benefit-check][data-selection-id="p2"]')).toBeEnabled();await p.locator('[data-benefit-check][data-selection-id="p2"]').check();await p.locator('[data-benefit-check][data-selection-id="e1"]').check();await expect(p.locator('#accessibleAdminBenefits').filter({hasText:'QA unclaimed'}).locator('input[data-selection-id=""]')).toBeDisabled();await click(p,'accessibleAdminSubmit');await expect(p.locator('#accessibleAdminModal')).toBeHidden();expect(calls(info.fixture,'admin.booking.receipt.register')[0].payload.benefits).toEqual([{kind:'points',id:'p2'},{kind:'event',id:'e1'}]);
});
test('BOOKING_ACCESSIBLE_EXISTING — bind existing completed booking and recheck current tickets',async({page:p},info)=>{
  seedBooking(info.fixture,'completed');await seedAccessible(p,info.fixture);await select(p,'accessibleAdminExisting','booking-1');await expect(p.locator('#accessibleAdminSubmit')).toBeEnabled();await expect(p.locator('#accessibleAdminNewFields')).toHaveAttribute('disabled','');await expect(p.locator('#accessibleAdminDate')).toBeDisabled();await expect(p.locator('#accessibleAdminMessage')).toContainText('已完成');await click(p,'accessibleAdminSubmit');await expect(p.locator('#accessibleAdminModal')).toBeHidden();expect(calls(info.fixture,'admin.booking.receipt.register')[0].payload.bookingId).toBe('booking-1');expect(calls(info.fixture,'admin.booking.receipt.options').some(c=>c.payload.bookingId==='booking-1')).toBe(true);
});

async function prepareAccessibleReview(p,s){
  await seedAccessible(p,s);await expect(p.locator('#accessibleAdminImage')).toHaveAttribute('src','https://fixture.supabase.co/storage/v1/object/sign/booking-receipts/qa.svg?token=fixture');
  await p.locator('[data-service-check]').first().check();await p.locator('[data-minutes]').first().fill('60');
  await fill(p,'accessibleAdminDate',today());await fill(p,'accessibleAdminTime','10:03');await fill(p,'accessibleAdminNote','QA review retained');
}
for(const code of ['BOOKING_CONFLICT','ADMIN_REQUIRED','API_RESPONSE_UNCERTAIN'])test('BOOKING_ACCESSIBLE_FAILURE_'+code+' — rejected review preserves receipt and form without a settlement',async({page:p},info)=>{
  await prepareAccessibleReview(p,info.fixture);info.fixture.fault={action:'admin.booking.receipt.register',code,message:'QA '+code};
  await click(p,'accessibleAdminSubmit');await expect(p.locator('#accessibleAdminMessage')).toContainText(code==='API_RESPONSE_UNCERTAIN'?'同一張收據':'QA '+code);
  await expect(p.locator('#accessibleAdminModal')).toBeVisible();await expect(p.locator('#accessibleAdminSubmit')).toBeEnabled();
  await expect(p.locator('#accessibleAdminNote')).toHaveValue('QA review retained');expect(info.fixture.settlements).toHaveLength(0);expect(info.fixture.submissions).toHaveLength(1);
  await click(p,'accessibleAdminSubmit');await expect(p.locator('#accessibleAdminModal')).toBeHidden();expect(info.fixture.settlements).toHaveLength(1);
  expect(calls(info.fixture,'admin.booking.receipt.register')[0].payload).toEqual(calls(info.fixture,'admin.booking.receipt.register')[1].payload);
});
test('BOOKING_ACCESSIBLE_UNCERTAIN_REPLAY — lost response replays same receipt and settles time and points once',async({page:p},info)=>{
  await prepareAccessibleReview(p,info.fixture);info.fixture.fault={action:'admin.booking.receipt.register',code:'API_RESPONSE_UNCERTAIN',afterCommit:true};
  await click(p,'accessibleAdminSubmit');await expect(p.locator('#accessibleAdminMessage')).toContainText('同一張收據');
  expect(info.fixture.settlements).toHaveLength(1);await click(p,'accessibleAdminSubmit');await expect(p.locator('#accessibleAdminModal')).toBeHidden();
  expect(info.fixture.settlements).toEqual([{serviceMinutes:60,rewards:[{points:2}],redemptions:[]}]);expect(info.fixture.accessibleRecords).toHaveLength(1);
  const writes=calls(info.fixture,'admin.booking.receipt.register');expect(writes).toHaveLength(2);expect(writes[0].payload).toEqual(writes[1].payload);
  await expect(p.locator('#accessibleAdminQueueList')).toContainText('60 分鐘');await p.reload();await booking(p,'bookingAdminQueueSubtab');await click(p,'bookingAdminAccessibleMode');
  await p.locator('[data-accessible-filter="completed"]').click();await expect(p.locator('#accessibleAdminQueueList')).toContainText('60 分鐘');
});
test('BOOKING_ACCESSIBLE_DOUBLE_SUBMIT — form lock rejects parallel submission and keeps modal open until confirmed',async({page:p},info)=>{
  await prepareAccessibleReview(p,info.fixture);let release;const wait=new Promise(resolve=>{release=resolve;});info.fixture.hold={action:'admin.booking.receipt.register',wait};
  try{
    await p.evaluate(()=>{const form=document.getElementById('accessibleAdminForm');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    await expect(p.locator('#accessibleAdminSubmit')).toBeDisabled();await expect(p.locator('#accessibleAdminForm')).toHaveAttribute('aria-busy','true');
    await expect.poll(()=>calls(info.fixture,'admin.booking.receipt.register').length).toBe(1);await expect(p.locator('#accessibleAdminClose')).toBeDisabled();await p.evaluate(()=>document.getElementById('accessibleAdminClose').click());await expect(p.locator('#accessibleAdminModal')).toBeVisible();
  }finally{release();}
  await expect(p.locator('#accessibleAdminModal')).toBeHidden();expect(calls(info.fixture,'admin.booking.receipt.register')).toHaveLength(1);expect(info.fixture.settlements).toHaveLength(1);
});

test('BOOKING_ACCESSIBLE_READ_FAILURE — unavailable options prevent review and reopening reloads authoritative data',async({page:p},info)=>{
  info.fixture.fault={action:'admin.booking.receipt.options',code:'DATABASE_ERROR',message:'QA options unavailable'};await seedAccessible(p,info.fixture);
  await expect(p.locator('#accessibleAdminMessage')).toContainText('QA options unavailable');await expect(p.locator('#accessibleAdminSubmit')).toBeDisabled();
  expect(calls(info.fixture,'admin.booking.receipt.register')).toHaveLength(0);expect(info.fixture.submissions).toHaveLength(1);
  await click(p,'accessibleAdminClose');await p.locator('#accessibleAdminQueueList button').click();await expect(p.locator('[data-service-check]').first()).toBeEnabled();
  await click(p,'accessibleAdminClose');await expect(p.locator('#accessibleAdminImage')).not.toHaveAttribute('src','https://fixture.supabase.co/storage/v1/object/sign/booking-receipts/qa.svg?token=fixture');
});
test('BOOKING_RELEASED_TICKET — booking and accessible history explain why a held ticket was released',async({page:p},info)=>{
  seedBooking(info.fixture);const benefit={kind:'points',id:'qa-released',title:'QA released coupon',sourceTitle:'QA card',ticketTitle:'QA released coupon',status:'cancelled',cancellationReason:'booking_services_changed'};
  info.fixture.bookings[0].benefits=[benefit];
  info.fixture.accessibleRecords=[{receiptId:'released-receipt',bookingId:'booking-1',status:'bound',reviewStatus:'completed',memberName:'QA Member',memberCode:'TEST1',createdAt:version,completedAt:version,serviceMinutes:30,points:0,services:[],benefits:[benefit]}];
  await booking(p,'bookingAdminQueueSubtab');await expect(p.locator('[data-booking-id="booking-1"]').first()).toContainText('項目變更，已解除綁定');
  await click(p,'bookingAdminAccessibleMode');await p.locator('[data-accessible-filter="completed"]').click();await p.locator('#accessibleAdminQueueList button').click();await expect(p.locator('#accessibleAdminRecordModal')).toContainText('項目變更，已解除綁定');
});

for(const kind of ['card','ticket','event','fixed'])test('SETTINGS_COPY_'+kind+' — preview, name, draft and independent source',async({page:p},info)=>{
 if(kind==='card'){await click(p,'cardsTab');await p.locator('#cardListItems .card-list-item-main').first().click();}
 else if(kind==='ticket'){await click(p,'cardsTab');await click(p,'ticketSettingsTab');await p.locator('[data-ticket-template-id]').first().click();}
 else{await openEvent(p,kind==='fixed'?'fixed':'coupon');await click(p,'saveEventTicketButton');await expect.poll(()=>kind==='fixed'?info.fixture.templates.length:info.fixture.eventTickets.length).toBe(1);}
 const [table,key,field]=({card:['cards','cardId','cardId'],ticket:['tickets','ticketTemplateId','ticketTemplateId'],event:['eventTickets','eventTicketId','eventTicketId'],fixed:['templates','fixedTicketId','eventTicketTitle']})[kind];
 const source=structuredClone(info.fixture[table][0]);await click(p,'copySettings-'+(kind==='fixed'?'event':kind));await expect(p.locator('#settingsCopyModal')).toBeVisible();await expect(p.locator('#settingsCopyPreview')).toContainText(source.title);
 await fill(p,'settingsCopyName','QA copied '+kind);await click(p,'settingsCopyConfirm');await expect(p.locator('#settingsCopyModal')).toBeHidden();await expect.poll(()=>info.fixture[table].length).toBe(kind==='card'?3:2);
 const copied=info.fixture[table].at(-1);expect(copied.status).toBe('draft');expect(copied[key]).not.toBe(source[key]);expect(info.fixture[table][0]).toEqual(source);
 if(kind==='fixed'){expect(copied.notifyLine).toBe(false);expect(copied.calendarEnabled).toBe(false);}else await expect(p.locator('#'+field)).toHaveValue(copied[key]);
 expect(calls(info.fixture,'admin.settings.copy')).toHaveLength(1);
});
test('TICKET_VISIBILITY — save both policies and reload persisted setting',async({page:p},info)=>{
 await click(p,'eventsTab');await expect(p.locator('#ticketVisibilityPolicy')).toBeEnabled();await expect(p.locator('#saveTicketVisibility')).toBeDisabled();await select(p,'ticketVisibilityPolicy','higher_preview');await expect(p.locator('#saveTicketVisibility')).toBeEnabled();await click(p,'saveTicketVisibility');await expect(p.locator('#ticketVisibilityStatus')).toContainText('已儲存');await p.reload();await click(p,'eventsTab');await expect(p.locator('#ticketVisibilityPolicy')).toHaveValue('higher_preview');await select(p,'ticketVisibilityPolicy','eligible_only');await click(p,'saveTicketVisibility');await expect.poll(()=>info.fixture.visibilityPolicy).toBe('eligible_only');
});

test('MEMBER_REMOVE — cancelled or mismatched confirmation has no effects; confirmed removal refreshes directory',async({page:p},info)=>{
  await openMember360(p);
  p.removeAllListeners('dialog');p.on('dialog',d=>d.dismiss());
  await p.getByRole('button',{name:'移除會員全部資料'}).click();expect(calls(info.fixture,'admin.member.remove')).toHaveLength(0);
  p.removeAllListeners('dialog');p.on('dialog',d=>d.type()==='prompt'?d.accept('wrong'):d.accept());
  await p.getByRole('button',{name:'移除會員全部資料'}).click();await expect(p.locator('#memberRecordsModalMessage')).toContainText('會員編號不符');expect(calls(info.fixture,'admin.member.remove')).toHaveLength(0);
  p.removeAllListeners('dialog');p.on('dialog',d=>d.type()==='prompt'?d.accept('TEST1'):d.accept());
  await p.getByRole('button',{name:'移除會員全部資料'}).click();await expect(p.locator('#memberRecordsModal')).toBeHidden();
  expect(calls(info.fixture,'admin.member.remove')).toHaveLength(1);expect(info.fixture.members).toHaveLength(2);
});

async function serviceGrant(p){await openMember360(p);await p.getByRole('button',{name:'＋ 發放'}).click();await select(p,'grantMode','services');await expect(p.locator('#grantServiceList [data-service-grant-id]')).toHaveCount(2);}
test('MEMBER_SERVICE_GRANT — empty selection, quantity, preview invalidation, double-submit and parent return',async({page:p},info)=>{
  await serviceGrant(p);await click(p,'previewServiceGrantButton');await expect(p.locator('#grantFormMessage')).toContainText('請選擇服務項目');expect(calls(info.fixture,'admin.service-grants.preview')).toHaveLength(0);
  await p.locator('#grantServiceList [data-service-grant-id]').first().check();await click(p,'previewServiceGrantButton');await expect(p.locator('#saveGrantButton')).toBeEnabled();
  await p.locator('#grantServiceList input[type=number]').first().fill('2');await p.locator('#grantServiceList input[type=number]').first().evaluate(input=>input.dispatchEvent(new Event('change',{bubbles:true}))); await expect(p.locator('#saveGrantButton')).toBeDisabled();
  await click(p,'previewServiceGrantButton');await expect(p.locator('#grantServicePreview')).toContainText('+60 分鐘');
  await p.locator('#saveGrantButton').evaluate(button=>{button.click();button.click();});await expect(p.locator('#grantModal')).toBeHidden();await expect(p.locator('#memberRecordsModal')).toBeVisible();
  expect(calls(info.fixture,'admin.service-grants.add')).toHaveLength(1);expect(info.fixture.members[0].serviceMinutesTotal).toBe(60);expect(info.fixture.grants[0].items[0].quantity).toBe(2);
  expect(info.fixture.grants[0].points).toBe(undefined);expect(info.fixture.grants[0].serviceTime).toBe(undefined);expect(info.fixture.grants[0].messagePresetId).toBe('');
});
test('MEMBER_SERVICE_GRANT_STALE — server conflict invalidates preview and leaves balance unchanged',async({page:p},info)=>{
  await serviceGrant(p);await p.locator('#grantServiceList [data-service-grant-id]').first().check();await click(p,'previewServiceGrantButton');await expect(p.locator('#saveGrantButton')).toBeEnabled();
  info.fixture.fault={action:'admin.service-grants.add',code:'SERVICE_GRANT_PREVIEW_STALE'};await click(p,'saveGrantButton');await expect(p.locator('#grantFormMessage')).toBeVisible();await expect(p.locator('#saveGrantButton')).toBeDisabled();expect(info.fixture.grants).toHaveLength(0);expect(info.fixture.members[0].serviceMinutesTotal).toBe(0);
  await click(p,'previewServiceGrantButton');await expect(p.locator('#saveGrantButton')).toBeEnabled();await click(p,'saveGrantButton');await expect(p.locator('#grantModal')).toBeHidden();expect(info.fixture.grants).toHaveLength(1);
});
test('MEMBER_SERVICE_GRANT_RETRY — uncertain commit locks writes until refresh and readback shows one credit',async({page:p},info)=>{
  await serviceGrant(p);await p.locator('#grantServiceList [data-service-grant-id]').first().check();await click(p,'previewServiceGrantButton');await expect(p.locator('#saveGrantButton')).toBeEnabled();
  info.fixture.fault={action:'admin.service-grants.add',afterCommit:true,code:'API_RESPONSE_UNCERTAIN'};await click(p,'saveGrantButton');await expect(p.locator('#grantFormMessage')).toBeVisible();expect(info.fixture.grants).toHaveLength(1);
  await expect(p.locator('#saveGrantButton')).toBeDisabled();await p.locator('#saveGrantButton').evaluate(button=>button.click());expect(calls(info.fixture,'admin.service-grants.add')).toHaveLength(1);
  await p.reload();await serviceGrant(p);await p.locator('#grantServiceList [data-service-grant-id]').first().check();await click(p,'previewServiceGrantButton');await expect(p.locator('#saveGrantButton')).toBeEnabled();
  expect(info.fixture.grants).toHaveLength(1);expect(info.fixture.members[0].serviceMinutesTotal).toBe(30);expect(calls(info.fixture,'admin.service-grants.add')).toHaveLength(1);
});
test('MEMBER_SERVICE_GRANT_CATALOG_FAILURE — empty/error catalog blocks submit and manual mode recovers',async({page:p},info)=>{
  info.fixture.fault={action:'admin.service-grants.catalog',code:'CATALOG_UNAVAILABLE'};await openMember360(p);await p.getByRole('button',{name:'＋ 發放'}).click();await select(p,'grantMode','services');await expect(p.locator('#grantServiceStatus')).toContainText('QA rejected write');await expect(p.locator('#saveGrantButton')).toBeDisabled();
  await select(p,'grantMode','manual');await expect(p.locator('#grantServiceFields')).toBeHidden();await select(p,'grantMode','services');await expect(p.locator('#grantServiceList [data-service-grant-id]')).toHaveCount(2);expect(info.fixture.grants).toHaveLength(0);
});

test('BOOKING_COMPLETED_CORRECTION — preview, reason, confirmation and persisted item readback',async({page:p},info)=>{
 seedBooking(info.fixture,'completed');await booking(p,'bookingAdminQueueSubtab');await p.locator('[data-booking-filter="completed"]').click();
 await p.getByRole('button',{name:'更正已完成訂單'}).click();
 await p.locator('[data-correction-service="service-1"]').check();await p.locator('[data-correction-minutes]').first().fill('90');await p.locator('[data-correction-reason]').fill('QA actual service minutes');
 await p.locator('#bookingAdminCrudModal button[type="submit"]').click();await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();
 expect(calls(info.fixture,'admin.booking.completed.preview')).toHaveLength(1);expect(calls(info.fixture,'admin.booking.completed.correct')).toHaveLength(1);
 expect(calls(info.fixture,'admin.booking.completed.correct')[0].payload.reason).toBe('QA actual service minutes');expect(calls(info.fixture,'admin.booking.completed.correct')[0].payload.expectedPreview.serviceMinutesDelta).toBe(60);
 expect(info.fixture.bookings[0].items[0].unitDurationMinutes).toBe(90);expect(info.fixture.bookings[0].status).toBe('completed');
 if(typeof p.screenshot==='function')await info.attach('completed-correction',{body:await p.screenshot({fullPage:true}),contentType:'image/png'});
});
for(const width of [390,1280])test('BOOKING_CANCELLATION_COPY_'+width+' — actual cancellation queue copy and overnight label do not mutate bookings',async({page:p},info)=>{
 if(typeof p.setViewportSize==='function')await p.setViewportSize({width,height:844});seedBooking(info.fixture,'confirmed');Object.assign(info.fixture.bookings[0],{bookingDate:'2026-12-31',startTime:'23:30',endTime:'00:00',startAt:'2026-12-31T23:30:00',endAt:'2027-01-01T00:00:00',cancellationRequestedAt:version});
 await booking(p,'bookingAdminQueueSubtab');await click(p,'bookingCancellationRequestFilter');await p.locator('#bookingCancellationReviewList .booking-copy-button').click();
 const text=await p.evaluate(()=>navigator.clipboard.readText());expect(text).toContain('23:30–00:00（隔日）');expect(text).toContain('QA先生');expect(text).toContain('QA service');
 expect(calls(info.fixture,'admin.approve')).toHaveLength(0);expect(calls(info.fixture,'admin.reject')).toHaveLength(0);expect(info.fixture.bookings[0].status).toBe('confirmed');
 if(typeof p.screenshot==='function')await info.attach('cancel-copy-layout',{body:await p.screenshot({fullPage:true}),contentType:'image/png'});
});

test('AUDIT_QUERY — filter, detail, cursor, empty state and authorization errors',async({page:p},info)=>{
 await click(p,'operationAuditTab');await expect(p.locator('#operationAuditList')).toContainText('修改預約選用票券');
 await p.locator('#operationAuditList summary').click();await expect(p.locator('#operationAuditList dl')).toContainText('預選數量');await expect(p.locator('#operationAuditList pre')).toHaveCount(0);
 await fill(p,'auditMemberCode','QA-MEMBER');await fill(p,'auditAction','BOOKING_BENEFITS_UPDATED');await select(p,'auditResult','success');await click(p,'auditSearch');
 expect(calls(info.fixture,'admin.audit.query').at(-1).payload.memberCode).toBe('QA-MEMBER');
 await click(p,'auditNext');await expect(p.locator('#operationAuditStatus')).toContainText('沒有紀錄');expect(calls(info.fixture,'admin.audit.query').at(-1).payload.cursor.id).toBe('booking:1');
 info.fixture.fault={action:'admin.audit.query',code:'ADMIN_REQUIRED',message:'您沒有查詢權限'};await click(p,'auditSearch');await expect(p.locator('#operationAuditStatus')).toContainText('您沒有查詢權限');await expect(p.locator('#operationAuditList')).toHaveText('');
 await click(p,'membersTab');await expect(p.locator('#operationAuditPanel')).toBeHidden();await expect(p.locator('#operationAuditTab')).toHaveAttribute('aria-selected','false');
});

for(const width of [390,1280])test('BOOKING_NO_SHOW_'+width+' — explicit confirmation, no debit and pending count readback',async({page:p},info)=>{
 if(typeof p.setViewportSize==='function')await p.setViewportSize({width,height:900});seedBooking(info.fixture);
 info.fixture.bookings[0].startAt='2000-01-01T10:00:00+08:00';info.fixture.bookings[0].endAt='2000-01-01T10:30:00+08:00';
 await booking(p,'bookingAdminQueueSubtab');const row=p.locator('[data-booking-id="booking-1"]');
 await row.getByRole('button',{name:'無故未到',exact:true}).click();await expect(p.locator('#bookingAdminCrudModal')).toContainText('不核銷票券、不扣點');
 await p.locator('#bookingAdminCrudModal button[type="submit"]').click();expect(calls(info.fixture,'admin.booking.status.update')).toHaveLength(0);
 await p.locator('#bookingAdminCrudModal input[type="checkbox"]').check();await p.locator('#bookingAdminCrudModal button[type="submit"]').click();
 await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();expect(info.fixture.bookings[0].status).toBe('no_show');expect(calls(info.fixture,'admin.booking.status.update')).toHaveLength(1);
 expect(calls(info.fixture,'admin.booking.status.complete')).toHaveLength(0);await expect(p.locator('#bookingAdminPendingCount')).toHaveText('0');
 await p.locator('[data-booking-filter="all"]').click();await expect(p.locator('#bookingAdminQueue')).toContainText('無故未到');
});


for(const width of [390,1280])test('BOOKING_CONFIRMED_NO_SHOW_'+width+' — confirmed booking keeps no-show action and audit-safe transition',async({page:p},info)=>{
 if(typeof p.setViewportSize==='function')await p.setViewportSize({width,height:900});
 seedBooking(info.fixture,'confirmed');
 info.fixture.bookings[0].startAt='2000-01-01T10:00:00+08:00';
 info.fixture.bookings[0].endAt='2000-01-01T10:30:00+08:00';
 await booking(p,'bookingAdminQueueSubtab');
 await p.locator('[data-booking-filter="confirmed"]').click();
 const row=p.locator('[data-booking-id="booking-1"]');
 const action=row.getByRole('button',{name:'無故未到',exact:true});
 await expect(action).toBeEnabled();
 await action.click();
 await expect(p.locator('#bookingAdminCrudModal')).toContainText('不核銷票券、不扣點');
 await expect(p.locator('#bookingAdminCrudModal')).not.toContainText('仍待確認');
 await p.locator('#bookingAdminCrudModal input[type="checkbox"]').check();
 await p.locator('#bookingAdminCrudModal button[type="submit"]').click();
 await expect(p.locator('#bookingAdminCrudModal')).toBeHidden();
 expect(info.fixture.bookings[0].status).toBe('no_show');
 expect(calls(info.fixture,'admin.booking.status.update').at(-1).payload.status).toBe('no_show');
 expect(calls(info.fixture,'admin.booking.status.complete')).toHaveLength(0);
 await expect(p.locator('#bookingAdminConfirmedCount')).toHaveText('0');
 await p.locator('[data-booking-filter="all"]').click();
 await expect(p.locator('#bookingAdminQueue')).toContainText('無故未到');
});
