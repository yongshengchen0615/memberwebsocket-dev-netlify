const {test,expect}=require('playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');

async function mount(page){
  await page.setContent('<main><button id="action">提交</button></main>');
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'async-action-feedback.css'),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'async-action-feedback.js'),'utf8')});
}

test('AC-001/002: concurrent backend operations keep accessible Loading visible until the last response',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mount(page);
  const banner=page.locator('.async-action-feedback');
  await expect(banner).toBeHidden();
  await page.evaluate(()=>{
    window.pending={};
    const first=new Promise(resolve=>{window.pending.finishFirst=resolve;});
    const second=new Promise(resolve=>{window.pending.finishSecond=resolve;});
    window.pending.first=AsyncActionFeedback.track('正在送出預約…',()=>first);
    window.pending.second=AsyncActionFeedback.track('正在同步資料…',()=>second);
  });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role','status');
  await expect(banner).toHaveAttribute('aria-live','polite');
  await expect(banner).toContainText('正在同步資料…');
  await page.evaluate(()=>window.pending.finishFirst(true));
  await expect(banner).toBeVisible();
  await page.evaluate(()=>window.pending.finishSecond(true));
  await expect(banner).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('AC-003: rejected response clears Loading without swallowing the original error',async({page})=>{
  await mount(page);
  const message=await page.evaluate(async()=>{
    try { await AsyncActionFeedback.track('正在儲存會員資料…',()=>Promise.reject(new Error('NETWORK_FAILED'))); }
    catch(error){return error.message;}
  });
  expect(message).toBe('NETWORK_FAILED');
  await expect(page.locator('.async-action-feedback')).toBeHidden();
});
test('AC-004: reduced motion does not play spinner animation while preserving status',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await mount(page);
  await page.evaluate(()=>{window.finishLoading=AsyncActionFeedback.begin('正在查詢可預約時段…');});
  await expect(page.locator('.async-action-feedback')).toContainText('正在查詢可預約時段…');
  const animation=await page.locator('.async-action-feedback-spinner').evaluate(element=>getComputedStyle(element).animationName);
  expect(animation).toBe('none');
  await page.evaluate(()=>window.finishLoading());
  await expect(page.locator('.async-action-feedback')).toBeHidden();
});

test('AC-006/007: fullscreen Loading blocks interaction through the request lifecycle',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mount(page);
  await page.evaluate(()=>{
    window.clickCount=0;
    document.querySelector('#action').addEventListener('click',()=>window.clickCount++);
    window.finishBlocking=AsyncActionFeedback.begin('正在儲存資料…');
  });
  const overlay=page.locator('.async-action-feedback');
  await expect(overlay).toBeVisible();
  await expect(page.locator('main')).toHaveJSProperty('inert',true);
  const bounds=await overlay.boundingBox();
  expect(bounds.x).toBe(0);
  expect(bounds.y).toBe(0);
  expect(bounds.width).toBe(390);
  expect(bounds.height).toBe(844);
  await page.evaluate(()=>document.querySelector('#action').click());
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
  await page.evaluate(()=>window.finishBlocking());
  await expect(overlay).toBeHidden();
  await expect(page.locator('main')).toHaveJSProperty('inert',false);
  await page.evaluate(()=>document.querySelector('#action').click());
  expect(await page.evaluate(()=>window.clickCount)).toBe(1);
});

test('AC-010: receipt modal cleanup remains interactive after pending upload releases',async({page})=>{
 await mount(page);
 await page.evaluate(()=>{
  const shell=document.querySelector('main');
  shell.inert=true; // receipt modal opened before the request
  const finish=AsyncActionFeedback.begin('正在安全上傳收據…');
  shell.inert=false; // receipt closeModal() ran during the request
  finish();
 });
 await expect(page.locator('main')).toHaveJSProperty('inert',false);
 await expect(page.locator('.async-action-feedback')).toBeHidden();
});

test('AC-011: native showModal dialog owns the visible full-screen Loading and releases it on close',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await mount(page);
 await page.evaluate(()=>{
  const modal=document.createElement('dialog');
  modal.id='testNativeModal';
  const button=document.createElement('button');
  button.type='button';
  button.id='nativeModalSave';
  button.textContent='儲存';
  modal.append(button);
  document.body.append(modal);
  modal.showModal();
  window.nativeModalClicks=0;
  button.addEventListener('click',()=>window.nativeModalClicks++);
  window.finishNativeLoading=AsyncActionFeedback.begin('正在儲存並等待後端確認…');
 });
 expect(await page.locator('#testNativeModal').evaluate(modal=>modal.matches(':modal'))).toBe(true);
 const overlay=page.locator('#testNativeModal .async-action-feedback');
 await expect(overlay).toBeVisible();
 await expect(page.locator('#testNativeModal')).toHaveJSProperty('inert',false);
 const bounds=await overlay.boundingBox();
 expect(bounds.x).toBe(0);
 expect(bounds.y).toBe(0);
 expect(bounds.width).toBe(390);
 expect(bounds.height).toBe(844);
 await page.evaluate(()=>document.querySelector('#nativeModalSave').click());
 expect(await page.evaluate(()=>window.nativeModalClicks)).toBe(0);
 // A dialog may close while a different pending request remains active.
 await page.evaluate(()=>document.querySelector('#testNativeModal').close());
 await expect(page.locator('body > .async-action-feedback')).toBeVisible();
 await page.evaluate(()=>window.finishNativeLoading());
 await expect(page.locator('.async-action-feedback')).toBeHidden();
});
