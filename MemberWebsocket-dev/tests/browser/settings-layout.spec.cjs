const {test,expect}=require('playwright/test');
const {startFixture}=require('./admin-fixture.cjs');
let host;
test.beforeAll(async()=>{host=await startFixture();});
test.afterAll(async()=>{await host.close();});

async function fitsViewport(page,locator) {
  const bounds=await locator.evaluate(el=>({
    left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,
    viewport:window.innerWidth,overflow:el.scrollWidth-el.clientWidth,
  }));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport+1);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
}

for(const variant of [
  {name:'desktop light',width:1280,theme:'light'},
  {name:'desktop dark',width:1280,theme:'dark'},
  {name:'mobile light',width:320,theme:'light'},
  {name:'mobile dark',width:390,theme:'dark'},
])test('settings layout '+variant.name,async({page},info)=>{
  await page.setViewportSize({width:variant.width,height:900});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Render production HTML, CSS and behavior against an isolated local transport.
  await page.route('https://**',route=>route.abort());
  await page.goto(host.base+'/admin/?run='+info.testId);
  await expect(page.locator('#adminView')).toBeVisible();
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,variant.theme);
  const topbar=page.locator('#adminView > .topbar');await fitsViewport(page,topbar);
  if(variant.width<=640) {
    const title=await topbar.locator('h1').boundingBox();const account=await topbar.locator('.account-menu').boundingBox();
    expect(title.y+title.height).toBeLessThanOrEqual(account.y);
    const lineHeight=await topbar.locator('h1').evaluate(el=>parseFloat(getComputedStyle(el).lineHeight));
    expect(title.height).toBeLessThanOrEqual(lineHeight+1);
  }
  await page.locator('#bookingTab').click();
  await page.locator('#bookingAdminTechniciansSubtab').click();
  const policy=page.locator('#bookingAdminPartySizeForm');
  await expect(policy).toBeVisible();
  await expect(page.locator('#bookingAdminPrimaryTechnician')).toHaveValue('tech-1');
  await fitsViewport(page,policy);
  const fields=await Promise.all(['bookingAdminPrimaryTechnician','bookingAdminMaxPartySize'].map(id=>page.locator('#'+id).boundingBox()));
  if(variant.width>640)expect(Math.abs(fields[0].y-fields[1].y)).toBeLessThanOrEqual(1);
  else expect(fields[1].y).toBeGreaterThan(fields[0].y+fields[0].height);
  await page.locator('#bookingAdminRequirePrimaryTechnician').uncheck();
  await expect(page.locator('#bookingAdminPrimaryRequirementHint')).toContainText('不必預約主要技師');
  const checkbox=await page.locator('#bookingAdminRequirePrimaryTechnician').boundingBox();expect(checkbox.height).toBeLessThanOrEqual(24);
  const save=await page.locator('#bookingAdminSavePartySizeButton').boundingBox();expect(save.height).toBeGreaterThanOrEqual(44);
  const policyImage=info.outputPath('primary-technician-settings.png');
  if(variant.width<=640) {
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({fullPage:true,path:policyImage});
  } else await policy.screenshot({path:policyImage});
  await info.attach('primary-technician-settings',{path:policyImage,contentType:'image/png'});

  await page.locator('#eventsTab').click();await page.locator('#newEventTicketButton').click();
  await page.locator('#eventTicketType').selectOption('fixed');
  const notification=page.locator('.fixed-ticket-notification');
  await expect(notification).toBeVisible();await fitsViewport(page,notification);
  await page.locator('#fixedTicketNotifyTime').fill('09:30');
  await expect(page.locator('#fixedTicketNotifySummary')).toContainText('09:30');
  await page.locator('#fixedTicketNotifyLine').uncheck();
  const notifyCheckbox=await page.locator('#fixedTicketNotifyLine').boundingBox();expect(notifyCheckbox.height).toBeLessThanOrEqual(24);
  await expect(page.locator('#fixedTicketNotifySummary')).toContainText('票券仍會依週期發放');
  await expect(page.locator('#fixedTicketNotifyTime')).toHaveValue('09:30');
  await page.locator('.fixed-ticket-notification-details summary').click();
  await expect(page.locator('.fixed-ticket-notification-details p')).toBeVisible();
  await fitsViewport(page,notification);
  const notificationImage=info.outputPath('fixed-ticket-notification-off.png');
  await notification.screenshot({path:notificationImage});
  await info.attach('fixed-ticket-notification-off',{path:notificationImage,contentType:'image/png'});
  await page.locator('#fixedTicketNotifyLine').check();
  await expect(page.locator('#fixedTicketNotifySummary')).toContainText('09:30');
  expect(errors).toEqual([]);expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});
