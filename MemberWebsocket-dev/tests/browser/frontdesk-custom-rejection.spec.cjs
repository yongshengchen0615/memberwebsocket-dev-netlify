const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const url=req.url.split('?')[0];
  if(url==='/config/config.json'){
   res.setHeader('Content-Type','application/json');
   return res.end(JSON.stringify({supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic-public'}));
  }
  const files={'/frontdesk/':'frontdesk/index.html','/frontdesk/app.js':'frontdesk/app.js',
   '/frontdesk/theme-toggle.js':'frontdesk/theme-toggle.js',
   '/frontdesk/styles.css':'frontdesk/styles.css',
   '/frontdesk/workspace-polish.css':'frontdesk/workspace-polish.css',
   '/theme.js':'theme.js','/theme.css':'theme.css'};
  const file=files[url];
  if(!file){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.resolve(__dirname,'../..',file)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));

for(const width of [390,1280])test('AC-003/004/005/006: booked-only vacation technicians, removed reasons and two-step confirmation '+width,async({page})=>{
 await page.setViewportSize({width,height:880});
 const ordinary='custom_11111111-2222-4333-8444-555555555555';
 const paired='custom_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const settings={dropdownTitle:'櫃檯請選擇拒絕原因',reasons:[
  {id:'technician_leave',label:'技師休假',memberDescription:'請改期',enabled:true,requiresConflictTime:false,hasVacationTechnicians:true},
  {id:ordinary,label:'設備維護',memberDescription:'設備維護，請改期',enabled:true,requiresConflictTime:false},
  {id:paired,label:'臨時保留現場',memberDescription:'原時間已有現場預約',enabled:true,requiresConflictTime:true,hasVacationTechnicians:true}
 ]};
 const ids=['10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000012'];
 const status=new Map(ids.map(id=>[id,'pending']));const writes=[];
 const booking=id=>({id,status:status.get(id),updatedAt:'2026-11-20T10:00:00Z',
  bookingDate:'2026-12-12',startAt:'2026-12-12T11:00:00',endAt:'2026-12-12T12:00:00',
  startTime:'11:00',endTime:'12:00',totalDurationMinutes:60,name:'測試會員',services:[],
  vacationTechnicians:id===ids[0]
    ?[{id:'10000000-0000-4000-8000-0000000000a1',name:'A'}]
    :[{id:'10000000-0000-4000-8000-0000000000b2',name:'B'}]});
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({
  contentType:'text/javascript',body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"synthetic",login:()=>{},logout:()=>{}};'}));
 await page.route('https://fixture.supabase.co/**',route=>{
  const input=route.request().postDataJSON();let data;
  if(input.action==='frontdesk.public')data={name:'測試店',frontdesk:{enabled:true,liffId:'2010999999-desk'}};
  else if(input.action==='frontdesk.bootstrap')data={staff:{displayName:'測試櫃檯',status:'approved',permissionMode:'review'}};
  else if(input.action==='frontdesk.bookings')data={rejectionSettings:settings,bookings:ids.filter(id=>status.get(id)==='pending').map(booking)};
  else if(input.action==='frontdesk.sync.status')data={revision:'1'};
  else if(input.action==='frontdesk.history')data={items:[]};
  else if(['frontdesk.booking.update','frontdesk.booking.reject-phone'].includes(input.action)){
   writes.push(input);status.set(input.bookingId,'rejected');data={booking:{status:'rejected'},alreadyApplied:false};
  }else throw Error('Unexpected action '+input.action);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 page.on('dialog',dialog=>dialog.accept());
 await page.goto(base+'/frontdesk/?business=shop-a');
 await expect(page.locator('.frontdesk-card')).toHaveCount(2);
 await page.getByRole('button',{name:'拒絕預約',exact:true}).first().click();
 const dialog=page.locator('[role=dialog]'),select=dialog.locator('select[aria-label="選擇拒絕預約原因"]');
 await expect(dialog).toContainText(settings.dropdownTitle);
 await expect(select.locator('option')).toHaveCount(4); // placeholder + three saved reasons
 await expect(select.locator('option[value="unrecorded_phone_booking"]')).toHaveCount(0);
 const panel=dialog.locator('.frontdesk-vacation-technicians');
 await expect(panel).toBeHidden();
 await select.selectOption('technician_leave');
 await expect(panel).toBeVisible();
 await expect(panel.getByRole('checkbox')).toHaveCount(1);
 await expect(panel).toContainText('A');
 await expect(panel).not.toContainText('B');
 await expect(dialog.getByRole('button',{name:'確認拒絕預約'})).toBeDisabled();
 await panel.getByRole('checkbox',{name:'A'}).check();
 await expect(dialog.locator('.frontdesk-rejection-member-preview p')).toHaveText('目前預約時間：2026/12/12 11:00，A 技師休假。');
 await expect(dialog.locator('.frontdesk-rejection-member-preview')).not.toContainText('請改期');
 await panel.getByRole('checkbox',{name:'A'}).uncheck();
 await expect(dialog.getByRole('button',{name:'確認拒絕預約'})).toBeDisabled();
 await panel.getByRole('checkbox',{name:'A'}).check();
 await select.selectOption(ordinary);
 await expect(panel).toBeHidden();
 await expect(dialog.locator('.frontdesk-rejection-member-preview')).toContainText('設備維護，請改期');
 await select.selectOption(ordinary);
 await expect(dialog.locator('.frontdesk-rejection-member-preview')).toContainText('設備維護，請改期');
 await expect(dialog.locator('[data-phone-registration]')).toBeHidden();
 await dialog.getByRole('button',{name:'確認拒絕預約'}).click();
 await expect(page.locator('.frontdesk-card')).toHaveCount(1);
 expect(writes).toHaveLength(1);
 expect(writes[0]).toMatchObject({action:'frontdesk.booking.update',rejectionReason:ordinary});
 expect(writes[0].phoneRequestId).toBeUndefined();
 await page.getByRole('button',{name:'拒絕預約',exact:true}).click();
 await select.selectOption(paired);
 await expect(dialog.locator('[data-phone-registration]')).toBeVisible();
 await expect(panel.getByRole('checkbox')).toHaveCount(1);
 await expect(panel).not.toContainText('A');
 await expect(panel).toContainText('B');
 await expect(dialog.getByRole('button',{name:'確認拒絕並登記現場預約'})).toBeDisabled();
 await panel.getByRole('checkbox',{name:'B'}).check();
 await expect(dialog.locator('.frontdesk-rejection-member-preview p')).toHaveText('目前預約時間：2026/12/12 11:00，B 技師休假。');
 await expect(dialog.getByRole('button',{name:'確認拒絕並登記現場預約'})).toBeEnabled();
 await dialog.getByRole('button',{name:'確認拒絕並登記現場預約'}).click();
 await expect(page.locator('.frontdesk-card')).toHaveCount(0);
 expect(writes).toHaveLength(2);
 expect(writes[1]).toMatchObject({action:'frontdesk.booking.reject-phone',rejectionReason:paired,
  startTime:'11:00',totalDurationMinutes:60,status:'rejected',
  vacationTechnicianIds:['10000000-0000-4000-8000-0000000000b2']});
 expect(writes[1].phoneRequestId).toMatch(/^PHONE-[0-9a-f-]{36}$/);
 expect(writes[1].bookingDate).toBeUndefined();
 expect(writes[1].items).toBeUndefined();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
