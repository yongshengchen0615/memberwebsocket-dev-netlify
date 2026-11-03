const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const inspect=page=>page.evaluate(()=>{
 const $=selector=>getComputedStyle(document.querySelector(selector));
 const token=(property,name)=>{
  const probe=document.createElement('span');
  probe.style[property]='var('+name+')';
  document.body.append(probe);
  const result=getComputedStyle(probe)[property];
  probe.remove();return result;
 };
 return {
  theme:document.documentElement.dataset.theme,
  card:$('.business-line-settings').backgroundColor,
  details:$('.business-line-settings details').backgroundColor,
  input:$('.business-line-settings input[type="text"]').backgroundColor,
  inputText:$('.business-line-settings input[type="text"]').color,
  note:$('.business-line-summary').backgroundColor,
  small:$('.business-line-settings small').color,
  code:$('.business-client-links code').backgroundColor,
  tab:$('.business-line-feature-nav button[aria-selected="false"]').backgroundColor,
  active:$('.business-line-feature-nav button[aria-selected="true"]').backgroundColor,
  activeText:$('.business-line-feature-nav button[aria-selected="true"]').color,
  surface:token('backgroundColor','--theme-surface-raised'),
  muted:token('backgroundColor','--theme-surface-muted'),
  positive:token('backgroundColor','--theme-positive'),
  positiveSoft:token('backgroundColor','--theme-positive-soft'),
  text:token('color','--theme-text'),
  secondary:token('color','--theme-text-muted'),
  bg:token('color','--theme-bg'),
  overflow:document.documentElement.scrollWidth>innerWidth+1,
 };
});
const matchTheme=(actual)=>{
 expect(actual.card).toBe(actual.surface);
 expect(actual.details).toBe(actual.muted);
 expect(actual.input).toBe(actual.surface);
 expect(actual.inputText).toBe(actual.text);
 expect(actual.note).toBe(actual.positiveSoft);
 expect(actual.small).toBe(actual.secondary);
 expect(actual.code).toBe(actual.muted);
 expect(actual.tab).toBe(actual.muted);
 expect(actual.active).toBe(actual.positive);
 expect(actual.activeText).toBe(actual.bg);
 expect(actual.overflow).toBe(false);
};
for(const width of [390,1280])test('AC-001/002 LINE theme toggle in Chromium '+width+'px',async({page},info)=>{
 await page.setViewportSize({width,height:800});
 await page.emulateMedia({colorScheme:'light'});
 await page.setContent(`<!doctype html><html><head><meta name="theme-color" content="#f9fbf9"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
 <div class="account-menu"><button id="logoutButton" type="button">登出</button></div>
 <section class="panel"><nav class="business-line-feature-nav"><button aria-selected="true">會員卡</button><button aria-selected="false">預約</button></nav>
 <section class="business-line-settings"><h2>會員卡 LINE 設定</h2><p class="business-line-summary">已設定</p>
 <details open><summary>Channel 與通知憑證</summary><form><label>LINE Channel ID<input type="text" value="1234567"></label>
 <label><input type="checkbox" checked>啟用通知</label><small>LINE Developers 設定說明</small><select><option>共用憑證</option></select></form></details>
 <div class="business-client-links"><a href="#" class="button">LINE 入口</a><code>https://example.test/booking/?business=demo</code></div>
 </section></section></body></html>`);
 for(const file of ['theme.css','admin/business-line-settings.css'])await page.addStyleTag({content:read(file)});
 await page.addScriptTag({content:read('theme.js')});
 const toggle=page.locator('#themeToggleButton');
 await expect(toggle).toHaveAttribute('aria-pressed','false');
 const light=await inspect(page);expect(light.theme).toBe('light');matchTheme(light);
 await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','true');
 const dark=await inspect(page);expect(dark.theme).toBe('dark');matchTheme(dark);
 for(const key of ['card','details','input','inputText','note','small','tab','active','activeText'])
  expect(dark[key],key+' updates on toggle').not.toBe(light[key]);
 await info.attach('line-settings-dark-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','false');
 const restored=await inspect(page);expect(restored.theme).toBe('light');matchTheme(restored);
 expect(restored.card).toBe(light.card);expect(restored.tab).toBe(light.tab);
});
