'use strict';
const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const style = fs.readFileSync(path.join(root, 'member/monthly-tier-benefits.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'member/monthly-tier-benefits.js'), 'utf8');
const tiers = [
  {key:'general',label:'一般會員',styleKey:'rose',offers:[{kind:'ticket',title:'入門優惠'}]},
  {key:'silver',label:'銀級會員',styleKey:'ocean',offers:[]},
  {key:'gold',label:'金級會員',styleKey:'cherry',offers:[]},
  {key:'platinum',label:'白金會員',styleKey:'mint',offers:[]},
];
const backgrounds = ['rgb(80, 29, 50)','rgb(13, 59, 76)','rgb(74, 23, 33)','rgb(30, 64, 57)'];
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body { box-sizing: border-box; padding: 12px; margin: 0; background: var(--theme-surface, #fff); }</style>
</head><body>
<details class="member-monthly-benefits" data-member-monthly-tier-widget>
 <summary class="member-monthly-benefits-heading"><strong>本月階級優惠</strong><small data-member-monthly-tier-teaser>展開查看</small></summary>
 <div class="member-monthly-benefits-body">
  <div class="member-monthly-benefits-controls"><span data-member-monthly-tier-month>本月</span><button type="button" data-member-monthly-tier-reload>更新</button></div>
  <p data-member-monthly-tier-status role="status"></p>
  <div class="member-monthly-benefits-tabs" data-member-monthly-tier-tabs role="group"></div>
  <div data-member-monthly-tier-overview></div>
 </div>
</details>
</body></html>`;
for (const theme of ['light','dark']) for (const width of [360,1280]) {
  test(`AC-020 monthly tier badges follow member-card palettes and pill style: ${theme} ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:820});
    await page.setContent(html);
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    await page.addStyleTag({content:style});
    await page.evaluate((tiers) => {
      window.BusinessContext={slug:'shop-test'};
      window.MemberSystem={request:async()=>({month:'2026-11',tiers})};
    }, tiers);
    await page.addScriptTag({content:script});
    await page.evaluate(() => window.MemberMonthlyTierBenefits.bind(
      document.querySelector('[data-member-monthly-tier-widget]'),
      {supabaseUrl:'https://example.supabase.co',business:'shop-test'},'test-token',
      {lineUserId:'member-a',tierKey:'silver',status:'active',profileComplete:true},
      'member'
    ));
    await page.locator('summary').click();
    const buttons=page.locator('.member-monthly-tab');
    await expect(buttons).toHaveCount(4);
    for(let i=0;i<4;i++){
      const button=buttons.nth(i);
      const visual=await button.evaluate(node=>{
        const tab=getComputedStyle(node),name=getComputedStyle(node.querySelector('.member-monthly-tab-label'));
        return {background:tab.backgroundColor,pillColor:name.color,pillBackground:name.backgroundColor,rounding:name.borderRadius,fontSize:name.fontSize,weight:name.fontWeight};
      });
      expect(visual.background).toBe(backgrounds[i]);
      expect(visual).toMatchObject({pillColor:'rgb(255, 255, 255)',pillBackground:'rgba(255, 255, 255, 0.14)',rounding:'999px',fontSize:width<=420?'11px':'12px',weight:'800'});
    }
    await buttons.nth(2).click();
    await expect(buttons.nth(2)).toHaveAttribute('aria-pressed','true');
    const detail=page.locator('.member-monthly-tier-heading h4');
    await expect(detail).toHaveText('金級會員');
    const detailVisual=await detail.evaluate(node=>{
      const name=getComputedStyle(node), heading=getComputedStyle(node.parentElement);
      return {background:heading.backgroundColor,pillColor:name.color,pillBackground:name.backgroundColor,rounding:name.borderRadius,fontSize:name.fontSize,weight:name.fontWeight};
    });
    expect(detailVisual).toEqual({background:backgrounds[2],pillColor:'rgb(255, 255, 255)',pillBackground:'rgba(255, 255, 255, 0.14)',rounding:'999px',fontSize:'12px',weight:'800'});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
