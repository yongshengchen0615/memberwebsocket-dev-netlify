const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'admin/booking-panel-core.js'),'utf8');
const from=source.indexOf('  function openRejectionModal(');
const to=source.indexOf('  async function updateBookingStatus(',from);
if(from<0||to<=from)throw Error('admin rejection modal source not found');
const modalFunction=source.slice(from,to).trim();
const ids={
 primary:'10000000-0000-4000-8000-000000000010',
 a:'10000000-0000-4000-8000-0000000000a1',
 b:'10000000-0000-4000-8000-0000000000b2',
 unrelated:'10000000-0000-4000-8000-0000000000cc'
};
for(const width of [390,1280])test('AC-005/006 real admin rejection modal: booked non-primary selections, mandatory and preview '+width,async({page})=>{
 await page.setViewportSize({width,height:820});
 await page.setContent('<!doctype html><html lang="zh-Hant"><body><section id="modal"><h3 id="title"></h3><div id="body"></div></section></body></html>');
 await page.evaluate(({modalFunction,ids})=>{
   const booking={bookingId:'10000000-0000-4000-8000-000000000099',bookingDate:'2026-12-12',startTime:'11:00',endTime:'12:00',totalDurationMinutes:60,updatedAt:'2026-11-20T10:00:00Z'};
   const state={busy:false,booking:{primaryTechnicianId:ids.primary,groups:{
    [booking.bookingId]:{participants:[
     {technicianId:ids.primary,technicianName:'主要技師',isPrimaryTechnician:true},
     {technicianId:ids.a,technicianName:'A',isPrimaryTechnician:false},
     {technicianId:ids.b,technicianName:'B',isPrimaryTechnician:false},
     {technicianId:ids.a,technicianName:'A',isPrimaryTechnician:false}
    ]}},technicians:[{technicianId:ids.unrelated,name:'不相關技師'}]}};
   const els={bookingAdminCrudModalTitle:document.querySelector('#title'),bookingAdminCrudModalBody:document.querySelector('#body')};
   const showMessage=(node,message)=>{node.textContent=message;node.hidden=false;};
   const clearMessage=node=>{node.textContent='';node.hidden=true;};
   const escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
   window.__calls=[];
   const bookingRequest=async(action,payload)=>{window.__calls.push({action,payload});};
   const runModalAction=async fn=>{await fn();};
   const showModal=()=>{},closeModal=()=>{};
   const factory=new Function('state','els','showMessage','clearMessage','escapeHtml','bookingRequest','runModalAction','showModal','closeModal', 'return '+modalFunction+';');
   const open=factory(state,els,showMessage,clearMessage,escapeHtml,bookingRequest,runModalAction,showModal,closeModal);
   open(booking,'管理備註');
 },{modalFunction,ids});
 const form=page.locator('[data-admin-rejection-form]');
 const reason=form.locator('[data-rejection-reason]');
 const panel=form.locator('[data-admin-vacation-technicians]');
 await expect(panel).toBeHidden();
 await reason.selectOption('technician_leave');
 await expect(panel).toBeVisible();
 await expect(panel.getByRole('checkbox')).toHaveCount(2);
 await expect(panel).toContainText('A');
 await expect(panel).toContainText('B');
 await expect(panel).not.toContainText('主要技師');
 await expect(panel).not.toContainText('不相關技師');
 await expect(form.locator('[data-submit]')).toBeDisabled();
 await panel.getByRole('checkbox',{name:'A'}).check();
 await panel.getByRole('checkbox',{name:'B'}).check();
 await expect(form.locator('[data-admin-vacation-preview]')).toContainText('目前預約時間：2026/12/12 11:00，A、B 技師休假。');
 await expect(form.locator('[data-submit]')).toBeEnabled();
 await form.locator('[data-submit]').click();
 let calls=await page.evaluate(()=>window.__calls);
 expect(calls).toHaveLength(1);
 expect(calls[0]).toMatchObject({action:'admin.booking.reject-vacation',payload:{
  rejectionReason:'technician_leave',vacationTechnicianIds:[ids.a,ids.b],status:'rejected',adminNote:'管理備註'}});
 expect(calls[0].payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
 await reason.selectOption('unrecorded_phone_booking');
 await expect(panel).toBeHidden();
 await expect(form.locator('[data-admin-vacation-preview]')).toBeHidden();
 expect((await page.evaluate(()=>window.__calls)).length).toBe(1);
});
