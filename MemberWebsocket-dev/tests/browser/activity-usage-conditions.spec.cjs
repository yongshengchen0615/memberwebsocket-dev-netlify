const {test,expect}=require('playwright/test');
const {startFixture,today}=require('./admin-fixture.cjs');

let host;
test.beforeAll(async()=>{host=await startFixture();});
test.afterAll(async()=>host.close());

for(const width of [390,1280]){
  test('AC-PARTY-BROWSER-'+width+': activity ticket party range roundtrips and invalid boundaries refused',async({page},info)=>{
    await page.setViewportSize({width,height:900});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://**',route=>route.abort());
    await page.goto(host.base+'/admin/?run='+encodeURIComponent(info.testId));
    await expect(page.locator('#adminView')).toBeVisible();
    await page.locator('#eventsTab').click();
    await page.locator('#newEventTicketButton').click();
    for(const [id,value] of Object.entries({
      eventTicketTitle:'預約人數活動票券',
      eventTicketDescription:'兩到四人專用活動票券',
      eventTicketUsageMethod:'一般預約',
      eventTicketUsageInstructions:'需符合整筆預約人數',
    }))await page.locator('#'+id).fill(value);
    await page.locator('#eventTicketStatus').selectOption('draft');
    await page.locator('#eventTicketMinBookingPartySize').fill('4');
    await page.locator('#eventTicketMaxBookingPartySize').fill('2');
    await page.locator('#saveEventTicketButton').click();
    await expect(page.locator('#eventTicketFormMessage')).toContainText('最多人數不可小於最少人數');
    expect(host.sessions.get(info.testId).calls.filter(c=>c.action==='admin.event-tickets.save')).toHaveLength(0);
    await page.locator('#eventTicketMinBookingPartySize').fill('2');
    await page.locator('#eventTicketMaxBookingPartySize').fill('4');
    await page.locator('#saveEventTicketButton').click();
    await expect.poll(()=>host.sessions.get(info.testId).eventTickets.length).toBe(1);
    const row=host.sessions.get(info.testId).eventTickets[0];
    expect(row.minBookingPartySize).toBe(2);
    expect(row.maxBookingPartySize).toBe(4);
    await page.reload();
    await expect(page.locator('#adminView')).toBeVisible();
    await page.locator('#eventsTab').click();
    await page.locator('[data-event-ticket-id="'+row.eventTicketId+'"]').first().click();
    await expect(page.locator('#eventTicketMinBookingPartySize')).toHaveValue('2');
    await expect(page.locator('#eventTicketMaxBookingPartySize')).toHaveValue('4');
    expect(host.sessions.get(info.testId).unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('AC-CALENDAR-BROWSER-'+width+': member activity service groups, money and party range',async({page},info)=>{
    await page.setViewportSize({width,height:900});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://**',route=>route.abort());
    await page.goto(host.base+'/admin/?run='+encodeURIComponent(info.testId));
    await expect(page.locator('#adminView')).toBeVisible();
    await page.locator('#calendarTab').click();
    await page.locator('#newCalendarItemButton').click();
    await page.locator('#calendarItemTitle').fill('雙人滿額會員活動');
    await page.locator('#calendarItemStatus').selectOption('draft');
    await page.locator('#calendarItemStartsOn').fill(today());
    await page.locator('#calendarItemEndsOn').fill(today());
    await page.locator('#calendarRequiredServiceMatchMode').selectOption('groups');
    const groups=page.locator('#calendarRequiredServiceGroups [data-service-combination]');
    await expect(groups).toHaveCount(1);
    await groups.first().locator('input[value="service-1"]').check();
    await groups.first().locator('input[value="service-2"]').check();
    await page.locator('#calendarRequiredServiceGroups .ticket-service-group-add').click();
    await groups.nth(1).locator('input[value="service-1"]').check();
    await page.locator('#calendarMinBookingAmountMode').selectOption('selected_services');
    await page.locator('#calendarMinBookingAmount').fill('150');
    await page.locator('#calendarMinBookingServiceIds input[value="service-2"]').check();
    await page.locator('#calendarMinBookingPartySize').fill('2');
    await page.locator('#calendarMaxBookingPartySize').fill('4');
    await page.locator('#saveCalendarItemButton').click();
    await expect.poll(()=>host.sessions.get(info.testId).calendarItems.length).toBe(1);
    const row=host.sessions.get(info.testId).calendarItems[0];
    expect(row.usageConditions).toMatchObject({
      requiredServiceMatchMode:'groups',
      requiredServiceGroups:[['service-1','service-2'],['service-1']],
      minBookingAmountMode:'selected_services',
      minBookingAmount:150,
      minBookingServiceIds:['service-2'],
      minBookingPartySize:2,
      maxBookingPartySize:4,
    });
    await page.reload();
    await expect(page.locator('#adminView')).toBeVisible();
    await page.locator('#calendarTab').click();
    // Open the saved activity via today's calendar day view.
    await page.locator('#adminCalendarGrid [data-admin-calendar-date="'+today()+'"]').first().click();
    await page.getByText('雙人滿額會員活動',{exact:true}).last().click();
    await expect(page.locator('#calendarRequiredServiceMatchMode')).toHaveValue('groups');
    await expect(page.locator('#calendarRequiredServiceGroups [data-service-combination]')).toHaveCount(2);
    await expect(page.locator('#calendarMinBookingAmount')).toHaveValue('150');
    await expect(page.locator('#calendarMinBookingPartySize')).toHaveValue('2');
    await expect(page.locator('#calendarMaxBookingPartySize')).toHaveValue('4');
    expect(host.sessions.get(info.testId).unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
