'use strict';
const {test,expect}=require('playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../member/monthly-tier-benefits.js'),'utf8');
const html=`<!doctype html><html lang="zh-Hant"><body>
<details class="member-monthly-benefits" data-member-monthly-tier-widget>
  <summary class="member-monthly-benefits-heading"><strong>本月階級優惠</strong><small data-member-monthly-tier-teaser>展開查看</small></summary>
  <div class="member-monthly-benefits-body">
    <span data-member-monthly-tier-month></span>
    <button data-member-monthly-tier-reload type="button">更新</button>
    <p data-member-monthly-tier-status role="status"></p>
    <div data-member-monthly-tier-tabs class="member-monthly-benefits-tabs"></div>
    <div data-member-monthly-tier-overview></div>
  </div>
</details></body></html>`;
test('AC-024: large authorized monthly catalogue displays every row and exact tab counts without a UI limit',async({page})=>{
  await page.setContent(html);
  await page.evaluate(()=>{
    const offers=Array.from({length:1205},(_,i)=>({
      kind:i%2?'activity':'ticket',title:'優惠-'+String(i).padStart(4,'0'),
      startsOn:'2026-11-01',endsOn:'2026-11-30'
    }));
    const tiers=[
      {key:'general',label:'一般會員',styleKey:'forest',offers},
      {key:'silver',label:'銀級會員',styleKey:'ocean',offers:offers.concat([{kind:'activity',title:'銀級額外活動'}])},
      {key:'gold',label:'金級會員',styleKey:'gold',offers:[]},
      {key:'platinum',label:'白金會員',styleKey:'platinum',offers:[]}
    ];
    window.__requests=0;
    window.MemberSystem={request:async()=>{window.__requests++;return {month:'2026-11',tiers};}};
  });
  await page.addScriptTag({content:source});
  await page.evaluate(()=>window.MemberMonthlyTierBenefits.bind(
    document.querySelector('[data-member-monthly-tier-widget]'),
    {supabaseUrl:'https://example.supabase.co',business:'test-merchant'},'test-token',
    {lineUserId:'qa-member',tierKey:'general',status:'active',membershipRequired:false,profileComplete:true},'member'));
  expect(await page.evaluate(()=>window.__requests)).toBe(0);
  await page.locator('summary').click();
  await expect(page.locator('[data-member-monthly-tier-tabs] button')).toHaveCount(4);
  await expect(page.locator('.member-monthly-offer')).toHaveCount(1205);
  await expect(page.locator('[data-tier-key="general"] .member-monthly-tab-count')).toHaveText('1205');
  await expect(page.locator('.member-monthly-offer').last()).toContainText('優惠-1204');
  await page.locator('[data-tier-key="silver"].member-monthly-tab').click();
  await expect(page.locator('[data-tier-key="silver"] .member-monthly-tab-count')).toHaveText('1206');
  await expect(page.locator('.member-monthly-offer')).toHaveCount(1206);
  await expect(page.locator('.member-monthly-offer').last()).toContainText('銀級額外活動');
  expect(await page.evaluate(()=>window.__requests)).toBe(1,'tier switching should not issue another API request');
  await page.locator('summary').click();
  await expect(page.locator('[data-member-monthly-tier-widget]')).not.toHaveAttribute('open');
});
