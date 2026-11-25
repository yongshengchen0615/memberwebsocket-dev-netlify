const {test,expect}=require('playwright/test');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
const fixture=`
window.calls=[];window.MembershipProgress={render(){}};
window.BookingSystem={loadConfig:async()=>({supabaseUrl:'https://booking-cancellation.supabase.co',supabasePublishableKey:'synthetic-fixture-key'}),signIn:async()=>'fixture',memberProfile:async()=>({lineUserId:'a'}),setBookingNotice:v=>{window.bookingNoticeValue=String(v||'');},formatDate:v=>v,subscribeRealtime:()=>()=>{},getSession:()=>({config:{},idToken:'fixture'}),addDays:(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),request:async(c,t,k,action)=>{calls.push(action);
if(action==='user.booking.bootstrap')return {serverNow:'2026-10-30T00:00:00Z',today:'2026-10-30',settings:{minAdvanceDays:0,maxAdvanceDays:3,bookingNotice:'商家測試預約說明'},services:[],bookings:[
{bookingId:'today',bookingDate:'2026-10-30',status:'confirmed',startTime:'15:00',endTime:'16:00',startAt:'2026-10-30T15:00:00+08:00',endAt:'2026-10-30T16:00:00+08:00',items:[]},
{bookingId:'tomorrow',bookingDate:'2026-10-31',status:'pending',startTime:'11:00',endTime:'12:00',items:[]},
{bookingId:'old',bookingDate:'2026-09-02',status:'completed',startTime:'11:00',endTime:'12:00',items:[]}]};
if(action==='user.booking.receipt.list')return {bookings:[],submissions:[{receiptId:'today',createdAt:'2026-10-29T16:00:00Z',status:'bound'},{receiptId:'yesterday',createdAt:'2026-10-29T15:59:00Z',status:'bound'}]};return {};}};`;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');
if(u.pathname==='/booking/'){let html=fs.readFileSync(path.join(root,'booking/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type','text/html');res.end(html.replace('</body>','<script src="/fixture.js"></script>'+['onsite-edit-policy.js','member-ui.js','app.js','booking-accessible.js','booking-receipt.js','calendar-flow.js','../dialog-accessibility.js'].map(f=>'<script src="'+f+'"></script>').join('')+'</body>'));return;}
if(u.pathname==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(fixture);return;}
const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');fs.createReadStream(file).pipe(res);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test.beforeEach(async({page})=>{
  // Fixtures assert on October dates; keep browser time deterministic across
  // month boundaries without altering timers, server policy or expectations.
  await page.clock.setFixedTime(new Date('2026-10-30T04:00:00.000Z'));
  // The synthetic 15:00 booking remains in the future at 12:00 Taiwan time.
  await page.route('https://**',r=>r.abort());
  // CSP permits *.supabase.co, so the synthetic API route remains reachable in Chromium.
  // Model the trusted cancellation-mode API, not a UI-only feature toggle.
  // Unlisted remote requests remain blocked by the route above.
  await page.route('https://booking-cancellation.supabase.co/functions/v1/booking-cancellation-api',route=>{
    const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'content-type,apikey'};
    if(route.request().method()==='OPTIONS') return route.fulfill({status:204,headers:cors});
    const mode=new URL(page.url()).searchParams.get('cancellationMode')||'approval';
    const action=JSON.parse(route.request().postData()||'{}').action;
    if(action!=='member.list') return route.fulfill({status:400,contentType:'application/json',headers:cors,body:JSON.stringify({ok:false,error:{code:'UNEXPECTED_ACTION'}})});
    return route.fulfill({status:200,contentType:'application/json',headers:cors,body:JSON.stringify({ok:true,data:{cancellationMode:mode,requests:[]}})});
  });
});
for(const width of [320,390,1280])test('date records and guarded start at '+width+'px',async({page},info)=>{
const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:840});await page.goto(base+'/booking/');await expect(page.locator('#calendarGrid')).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.bookingNoticeValue)).toBe('商家測試預約說明');await expect(page.locator('#bookingList')).toBeHidden();await expect(page.locator('#bookingSnapshotHistory')).toBeHidden();
const before=await page.evaluate(()=>calls.length);await page.locator('[data-date="2026-10-30"]').click();const modal=page.locator('#bookingDayModal');await expect(modal).toBeVisible();await expect(modal.locator('[data-booking-id]')).toHaveCount(1);await expect(modal.locator('[data-booking-id="today"]')).toBeVisible();await expect(modal.locator('[data-receipt-id]')).toHaveCount(1);await expect(modal.locator('[data-receipt-id="today"]')).toBeVisible();await modal.locator('.booking-item-top').click();await expect(modal.getByRole('button',{name:'修改預約',exact:true})).toBeVisible();await expect(modal.getByRole('button',{name:'申請取消',exact:true})).toBeVisible();await expect(modal.getByRole('button',{name:'申請取消',exact:true})).toBeEnabled();await expect(modal.getByRole('button',{name:'取消預約',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>calls.length)).toBe(before);
await page.keyboard.press('Escape');await expect(modal).toBeHidden();await expect(page.locator('[data-date="2026-10-30"]')).toBeFocused();await page.locator('[data-date="2026-10-31"]').click();await expect(modal.locator('[data-booking-id]')).toHaveCount(1);await expect(modal.locator('[data-booking-id="tomorrow"]')).toBeVisible();await expect(page.locator('#bookingSnapshotDayEmpty')).toBeVisible();await page.locator('#startDayBookingButton').click();await expect(page.locator('#appointmentPanel')).toBeVisible();await expect(page.locator('#bookingDate')).toHaveValue('2026-10-31');await page.locator('#closeAppointmentButton').click();await expect(page.locator('#appointmentPanel')).toBeHidden();await expect(modal).toBeVisible();await expect(page.locator('#bookingDayTitle')).toContainText('2026-10-31');await expect(page.locator('#closeBookingDayButton')).toBeFocused();await page.locator('#closeBookingDayButton').click();await expect(modal).toBeHidden();await page.locator('[data-date="2026-10-29"]').click();await expect(page.locator('#startDayBookingButton')).toBeDisabled();await expect(modal.locator('[data-receipt-id="yesterday"]')).toBeVisible();expect(await modal.locator('.booking-day-card').evaluate(e=>e.getBoundingClientRect().width<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('day-records.png')});expect(errors).toEqual([]);
});
test('trusted frontdesk mode exposes direct cancellation without the old approval action',async({page})=>{
  await page.goto(base+'/booking/?cancellationMode=direct');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.locator('[data-date="2026-10-30"]').click();
  const modal=page.locator('#bookingDayModal');
  await modal.locator('.booking-item-top').click();
  await expect(modal.getByRole('button',{name:'取消預約',exact:true})).toBeVisible();
  await expect(modal.getByRole('button',{name:'取消預約',exact:true})).toBeEnabled();
  await expect(modal.getByRole('button',{name:'申請取消',exact:true})).toHaveCount(0);
});

test('untrusted cancellation mode fails closed without exposing an enabled cancellation action',async({page})=>{
  await page.goto(base+'/booking/?cancellationMode=unknown');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.locator('[data-date="2026-10-30"]').click();
  const modal=page.locator('#bookingDayModal');
  await modal.locator('.booking-item-top').click();
  await expect(modal.getByRole('button',{name:'取消功能暫時無法確認',exact:true})).toBeDisabled();
  await expect(modal.getByRole('button',{name:'取消預約',exact:true})).toHaveCount(0);
  await expect(modal.getByRole('button',{name:'申請取消',exact:true})).toHaveCount(0);
});

test('deep link keeps history and snapshot mode hides calendar until returning to booking', async ({page}) => {
  await page.goto(base+'/booking/?bookingId=old');
  await expect(page.locator('#bookingDayModal')).toBeVisible();
  await expect(page.locator('#bookingDayTitle')).toContainText('2026-09-02');
  await expect(page.locator('[data-booking-id="old"]')).toBeVisible();
  await expect(page.locator('#startDayBookingButton')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.locator('#bookingAccessibleToggle').click();
  await expect(page.locator('#bookingAccessibleToggle')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#bookingAccessiblePanel')).toBeVisible();
  await expect(page.locator('[data-booking-standard]')).toBeHidden();
  await expect(page.locator('#calendarGrid')).toBeHidden();
  await page.locator('#bookingAccessibleToggle').click();
  await expect(page.locator('#bookingAccessibleToggle')).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.locator('#nextMonthButton').click();
  await page.locator('[data-date="2026-10-31"]').click();
  await page.locator('#startDayBookingButton').click();
  await expect(page.locator('#appointmentPanel')).toBeVisible();
  await expect(page.locator('#bookingAccessibleToggle')).toHaveAttribute('aria-pressed','false');
});

test('member booking allows per-appointment LINE reminder consent and previous-day time', async ({page}) => {
  await page.goto(base + '/booking/');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.locator('[data-date="2026-10-31"]').click();
  await page.locator('#startDayBookingButton').click();
  await expect(page.locator('#appointmentPanel')).toBeVisible();
  const consent = page.locator('#bookingReminderEnabled');
  const time = page.locator('#bookingReminderTime');
  await expect(consent).not.toBeChecked();
  await expect(time).toBeDisabled();
  await consent.check();
  await expect(time).toBeEnabled();
  await time.fill('19:30');
  await expect(time).toHaveValue('19:30');
  await consent.uncheck();
  await expect(time).toBeDisabled();
});

for (const width of [390, 1280]) test('phone-only date displays reference items, not an online form, at '+width+'px', async ({ page }) => {
  await page.setViewportSize({ width, height: 840 });
  await page.goto(base + '/booking/');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('booking:settings-updated', {
      detail: { today: '2026-10-30', settings: { minAdvanceDays: 2, maxAdvanceDays: 3, phoneBookingNumber: '06-1234567' } },
    }));
    window.dispatchEvent(new CustomEvent('booking:services-updated', {
      detail: { services: [{ serviceId: 'service-1', title: '舒緩服務', durationMinutes: 50, priceAmount: 700 }] },
    }));
  });
  await page.locator('[data-date="2026-10-30"]').click();
  await expect(page.locator('#bookingPhoneServiceReference')).toBeVisible();
  await expect(page.locator('#bookingPhoneServiceList')).toContainText('舒緩服務');
  await expect(page.locator('#bookingPhoneServiceList')).toContainText('NT$700');
  await expect(page.locator('#bookingPhoneServiceList button')).toHaveCount(0);
  await expect(page.locator('#startDayBookingButton')).toBeHidden();
  await expect(page.locator('#bookingPhoneDial')).toHaveAttribute('href', 'tel:061234567');
  await expect(page.locator('#appointmentPanel')).toBeHidden();
});

for (const width of [390, 1280]) test('technician leave hides both footer booking buttons at '+width+'px', async ({ page }) => {
  await page.setViewportSize({ width, height: 840 });
  await page.route('https://booking-cancellation.supabase.co/functions/v1/booking-calendar-api', route =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, data: {
        today: '2026-10-30',
        settings: { minAdvanceDays: 2, maxAdvanceDays: 4, phoneBookingNumber: '06-1234567' },
        holidays: [{ title: '技師休假', description: '當天休息', startsOn: '2026-10-31', endsOn: '2026-10-31' }],
      } }),
    })
  );
  await page.goto(base + '/booking/');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await page.evaluate(() => {
    window.liff = { isLoggedIn: () => true, getIDToken: () => 'fixture' };
    window.dispatchEvent(new Event('booking:view-shown'));
  });
  await expect(page.locator('[data-date="2026-10-31"]')).toContainText('技師休假');
  await page.locator('[data-date="2026-10-31"]').click();
  await expect(page.locator('#bookingDayHolidayNotice')).toBeVisible();
  await expect(page.locator('#bookingDayHolidayNotice')).toContainText('技師休假提醒');
  await expect(page.locator('#bookingDayHolidayDetails')).toContainText('當天休息');
  await expect(page.locator('#startDayBookingButton')).toBeHidden();
  await expect(page.locator('#bookingPhoneFallback')).toBeHidden();
  await expect(page.locator('#bookingPhoneServiceReference')).toBeHidden();
  await expect(page.locator('#appointmentPanel')).toBeHidden();
});
