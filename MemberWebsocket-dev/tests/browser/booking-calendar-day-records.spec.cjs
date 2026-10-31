const {test,expect}=require('playwright/test');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
const fixture=`
window.calls=[];window.MembershipProgress={render(){}};
window.BookingSystem={loadConfig:async()=>({}),signIn:async()=>'fixture',memberProfile:async()=>({lineUserId:'a'}),formatDate:v=>v,subscribeRealtime:()=>()=>{},getSession:()=>({config:{},idToken:'fixture'}),addDays:(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),request:async(c,t,k,action)=>{calls.push(action);
if(action==='user.booking.bootstrap')return {serverNow:'2026-10-30T00:00:00Z',today:'2026-10-30',settings:{minAdvanceDays:0,maxAdvanceDays:3},services:[],bookings:[
{bookingId:'today',bookingDate:'2026-10-30',status:'confirmed',startTime:'09:00',endTime:'10:00',items:[]},
{bookingId:'tomorrow',bookingDate:'2026-10-31',status:'pending',startTime:'11:00',endTime:'12:00',items:[]},
{bookingId:'old',bookingDate:'2026-09-02',status:'completed',startTime:'11:00',endTime:'12:00',items:[]}]};
if(action==='user.booking.receipt.list')return {bookings:[],submissions:[{receiptId:'today',createdAt:'2026-10-29T16:00:00Z',status:'bound'},{receiptId:'yesterday',createdAt:'2026-10-29T15:59:00Z',status:'bound'}]};return {};}};`;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');
if(u.pathname==='/booking/'){let html=fs.readFileSync(path.join(root,'booking/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type','text/html');res.end(html.replace('</body>','<script src="/fixture.js"></script>'+['member-ui.js','app.js','booking-accessible.js','booking-receipt.js','calendar-flow.js','../dialog-accessibility.js'].map(f=>'<script src="'+f+'"></script>').join('')+'</body>'));return;}
if(u.pathname==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(fixture);return;}
const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');fs.createReadStream(file).pipe(res);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test.beforeEach(async({page})=>{await page.route('https://**',r=>r.abort());});
for(const width of [320,390,1280])test('date records and guarded start at '+width+'px',async({page},info)=>{
const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:840});await page.goto(base+'/booking/');await expect(page.locator('#calendarGrid')).toBeVisible();await expect(page.locator('#bookingList')).toBeHidden();await expect(page.locator('#bookingSnapshotHistory')).toBeHidden();
const before=await page.evaluate(()=>calls.length);await page.locator('[data-date="2026-10-30"]').click();const modal=page.locator('#bookingDayModal');await expect(modal).toBeVisible();await expect(modal.locator('[data-booking-id]')).toHaveCount(1);await expect(modal.locator('[data-booking-id="today"]')).toBeVisible();await expect(modal.locator('[data-receipt-id]')).toHaveCount(1);await expect(modal.locator('[data-receipt-id="today"]')).toBeVisible();await modal.locator('.booking-item-top').click();await expect(modal.getByRole('button',{name:'修改預約',exact:true})).toBeVisible();await expect(modal.getByRole('button',{name:'申請取消',exact:true})).toBeVisible();expect(await page.evaluate(()=>calls.length)).toBe(before);
await page.keyboard.press('Escape');await expect(modal).toBeHidden();await expect(page.locator('[data-date="2026-10-30"]')).toBeFocused();await page.locator('[data-date="2026-10-31"]').click();await expect(modal.locator('[data-booking-id]')).toHaveCount(1);await expect(modal.locator('[data-booking-id="tomorrow"]')).toBeVisible();await expect(page.locator('#bookingSnapshotDayEmpty')).toBeVisible();await page.locator('#startDayBookingButton').click();await expect(page.locator('#appointmentPanel')).toBeVisible();await expect(page.locator('#bookingDate')).toHaveValue('2026-10-31');await page.locator('#closeAppointmentButton').click();await page.locator('[data-date="2026-10-29"]').click();await expect(page.locator('#startDayBookingButton')).toBeDisabled();await expect(modal.locator('[data-receipt-id="yesterday"]')).toBeVisible();expect(await modal.locator('.booking-day-card').evaluate(e=>e.getBoundingClientRect().width<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('day-records.png')});expect(errors).toEqual([]);
});
test('deep link opens historical date and snapshot mode keeps calendar',async({page})=>{await page.goto(base+'/booking/?bookingId=old');await expect(page.locator('#bookingDayModal')).toBeVisible();await expect(page.locator('#bookingDayTitle')).toContainText('2026-09-02');await expect(page.locator('[data-booking-id="old"]')).toBeVisible();await expect(page.locator('#startDayBookingButton')).toBeDisabled();await page.keyboard.press('Escape');await page.locator('#bookingAccessibleToggle').click();await expect(page.locator('#calendarGrid')).toBeVisible();await page.locator('#nextMonthButton').click();await page.locator('[data-date="2026-10-31"]').click();await page.locator('#startDayBookingButton').click();await expect(page.locator('#appointmentPanel')).toBeVisible();await expect(page.locator('#bookingAccessibleToggle')).toHaveAttribute('aria-pressed','false');});

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
