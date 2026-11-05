const {test,expect}=require('playwright/test');const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/booking-price-editor.css"><button id="open">調整價格</button><script src="/admin/booking-price-editor.js"></script><script>window.calls=[];window.publications=[];document.getElementById("open").onclick=()=>BookingPriceEditor.open({service:{serviceId:"10000000-0000-4000-8000-000000000001",title:"肩頸服務",priceAmount:500,priceVersion:"20000000-0000-4000-8000-000000000001"},request:async(action,payload)=>{calls.push({action,payload});if(action.endsWith(".catalog"))return {publications};if(window.conflict)throw Error("價格已被其他管理員更新");return {publication:{id:"new"}};},onSaved:async()=>{window.saved=true;}});</script></html>');return;
  }
  const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(r=>server.close(r)));
for(const v of [{width:320,theme:'light'},{width:390,theme:'dark'},{width:1280,theme:'light'},{width:1280,theme:'dark'}]){
 test(`AC-002/003/011: per-item immediate and Taipei scheduled price ${v.width} ${v.theme}`,async({page})=>{
  await page.setViewportSize({width:v.width,height:844});await page.goto(base);
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,v.theme);
  await page.getByRole('button',{name:'調整價格'}).click();
  const d=page.getByRole('dialog');await expect(d).toContainText('目前價格');
  await expect(d.getByLabel('新價格（NT$）')).toBeFocused();
  expect(await d.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await d.getByLabel('新價格（NT$）').fill('800');
  await d.getByRole('button',{name:'立即發佈',exact:true}).click();await expect(d).toHaveCount(0);
  expect(await page.evaluate(()=>calls.find(x=>x.action.endsWith('.publish')).payload.priceAmount)).toBe(800);
  await page.getByRole('button',{name:'調整價格'}).click();
  await d.getByLabel('發佈方式').selectOption('scheduled');await d.getByLabel('生效時間（台北時間 UTC+08:00）').fill('2035-11-10T09:30');
  await d.getByLabel('新價格（NT$）').fill('900');await d.getByRole('button',{name:'設定發佈時間',exact:true}).click();
  expect(await page.evaluate(()=>calls.filter(x=>x.action.endsWith('.publish')).at(-1).payload.publishAt)).toBe('2035-11-10T09:30:00+08:00');
 });
}
test('AC-004/011: pending price reschedule, cancellation and conflict keep the intended item and draft',async({page})=>{
 await page.goto(base);await page.evaluate(()=>{
  publications=[{id:'future-1',priceAmount:850,publishAt:'2035-11-10T01:30:00Z',updatedAt:'2030-01-01T00:00:00Z',status:'scheduled'}];
 });await page.getByRole('button',{name:'調整價格'}).click();
 const d=page.getByRole('dialog');await d.getByRole('button',{name:'改期',exact:true}).click();
 await expect(d.getByLabel('新價格（NT$）')).toHaveValue('850');
 await d.getByLabel('生效時間（台北時間 UTC+08:00）').fill('2035-11-12T10:00');
 await page.evaluate(()=>window.conflict=true);await d.getByRole('button',{name:'儲存改期',exact:true}).click();
 await expect(d.getByRole('status')).toContainText('價格已被其他管理員更新');await expect(d.getByLabel('新價格（NT$）')).toHaveValue('850');
 await expect(d.getByRole('button',{name:'儲存改期',exact:true})).toBeEnabled();
 await page.keyboard.press('Escape');await expect(d).toHaveCount(0);await expect(page.getByRole('button',{name:'調整價格'})).toBeFocused();
});
