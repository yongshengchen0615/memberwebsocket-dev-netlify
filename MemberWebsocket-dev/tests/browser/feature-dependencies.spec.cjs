const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
for(const width of [390,1280])test(`FEATURE_DEPENDENCIES_${width}: nested controls follow revoke/re-enable and late mount`,async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const html=fs.readFileSync(path.join(root,'admin/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi,'');
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(html);
 await page.addStyleTag({path:path.join(root,'admin/styles.css')});
 await page.addScriptTag({path:path.join(root,'admin/business-workspace.js')});
 await page.evaluate(()=>{
  document.getElementById('grantModal').classList.remove('hidden');
  window.BusinessWorkspace.apply({features:{membership:true,events:true,booking:true},business:{slug:'fixture',name:'QA'}});
 });
 await expect(page.locator('#grantServiceTimeEnabled')).toBeVisible();
 await expect(page.locator('#grantStampsEnabled')).toBeHidden();
 await expect(page.locator('#grantMode option[value=services]')).toHaveJSProperty('disabled',true);
 await page.locator('#grantMode').focus();await page.keyboard.press('ArrowDown');
 await expect(page.locator('#grantMode')).toHaveValue('manual');
 await page.evaluate(()=>{
  const block=document.createElement('section');block.id='calendarBonusPointsControls';block.textContent='活動加贈點數';document.getElementById('grantForm').append(block);
 });
 await expect(page.locator('#calendarBonusPointsControls')).toBeHidden();
 await page.evaluate(()=>window.BusinessWorkspace.apply({features:{membership:true,points:true,events:true,booking:true,calendar:true},business:{slug:'fixture',name:'QA'}}));
 await expect(page.locator('#grantStampsEnabled')).toBeVisible();
 await expect(page.locator('#grantMode option[value=services]')).toHaveJSProperty('disabled',false);
 await page.locator('#grantMode').selectOption('services');
 await expect(page.locator('#grantMode')).toHaveValue('services');
 await expect(page.locator('#calendarBonusPointsControls')).toBeVisible();
 await page.evaluate(()=>window.BusinessWorkspace.apply({features:{membership:true},business:{slug:'fixture',name:'QA'}}));
 await expect(page.locator('#grantStampsEnabled')).toBeHidden();
 await expect(page.locator('#grantMode')).toHaveValue('manual');
 await expect(page.locator('#calendarBonusPointsControls')).toBeHidden();
 expect(errors).toEqual([]);
 await info.attach('feature-dependencies',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});
