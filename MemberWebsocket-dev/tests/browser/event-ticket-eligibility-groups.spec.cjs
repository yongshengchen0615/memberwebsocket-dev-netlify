// AC-EVENT-GROUP-001..005: member event tickets stay readable by eligibility, never authorizing redemption in the UI.
const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const ids = [
  'app','loadingView','loadingProgress','loadingProgressBar','loadingProgressText','loadingStatus',
  'errorView','errorTitle','errorMessage','joinMemberButton','retryButton','eventView','displayName',
  'membershipProgress','eventSummary','eventList','emptyView','usedTicketHistory','usedTicketHistorySummary',
  'usedTicketList','ticketModal','closeTicketModal','ticketModalType','ticketModalTitle','ticketModalDate',
  'ticketModalDescription','ticketModalUsageMethod','ticketModalUsageInstructions','ticketModalServiceRequirement',
  'ticketModalAmountRequirement','ticketModalPrizes','ticketModalStatus','ticketModalProcessing',
  'ticketModalProcessingText','ticketModalResult','ticketModalAction','refreshTicketButton',
  'ticketModalMessage','ticketModalLocationStatus','ticketModalLocationButton',
  'ticketTransferPanel','ticketTransferFriendSelect','ticketTransferStatus','ticketTransferButton'
];
const markup = ids.map((id) => {
  if (id === 'ticketTransferFriendSelect') return '<select id="ticketTransferFriendSelect"><option value="">選擇</option></select>';
  if (id === 'ticketTransferPanel') return '<section id="ticketTransferPanel" hidden></section>';
  if (id.includes('Button') || ['closeTicketModal','joinMemberButton','retryButton','ticketModalAction'].includes(id))
    return '<button id="' + id + '" type="button"></button>';
  return '<div id="' + id + '"></div>';
}).join('\n');
const bootstrap = `
  const offer=(id,title,tierEligible,canUse,extra={})=>({
    ticket:{eventTicketId:id,title,description:'票券使用說明',ticketType:'coupon',
      startsOn:'2026-11-01',endsOn:'2026-12-31',allowedTierLabels:tierEligible?['一般會員']:['金級會員']},
    claim:{claimId:'CLAIM-'+id,status:'available'},availability:'active',
    tierEligible,canUse,...extra
  });
  window.__offers=[
    offer('ACTIVE','一般可用券',true,true),
    offer('GOLD','金級限定券',false,false,{locked:true,lockReason:'需要金級會員'}),
    offer('GIFT','好友贈送高階券',true,true,{receivedAsGift:true,giftFromDisplayName:'好友'}),
    offer('BOOK','需預約券',true,false),
    offer('OLD','已到期券',true,false,{availability:'expired'}),
    offer('AWAY','已轉贈出去的券',true,false,{transferredOut:true})
  ];
  window.MemberSystem={
    bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=>'synthetic-token',
    subscribeRealtime(_cfg,_surface,cb){window.__realtime=cb;},
    request:async()=>({profile:{displayName:'測試會員'},offers:window.__offers,
      usedTickets:[],usedTicketCount:0,bookingSelections:[]})
  };
  window.MembershipProgress={render(){}};
`;
const html = [
  '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<style>.hidden{display:none!important}</style>',
  '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/theme.css">',
  '<link rel="stylesheet" href="/event-ticket-ui.css">',
  '<script>' + bootstrap + '</script>',
  '<script defer src="/event-ticket-ui.js"></script><script defer src="/app.js"></script></head><body>',
  '<main id="app"><div id="syncNotice"></div>' + markup + '</main>',
  '<script>document.getElementById("ticketModal").classList.add("hidden");</script>',
  '</body></html>'
].join('\n');
const resources = {'/app.js':'event/app.js','/event-ticket-ui.js':'event-ticket-ui.js',
  '/styles.css':'event/styles.css','/event-ticket-ui.css':'event-ticket-ui.css','/theme.css':'theme.css'};
let server, base;
test.beforeAll(async () => {
  server=http.createServer((req,res)=>{
    if(resources[req.url]){
      res.writeHead(200,{'Content-Type':req.url.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});
      res.end(fs.readFileSync(path.join(root,resources[req.url]),'utf8'));return;
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{if(server)await new Promise(resolve=>server.close(resolve));});

for (const width of [390,1280]) {
  test('AC-EVENT-GROUP-001..003: group by server tier eligibility, preserve issued/gift/expired cards at '+width+'px',async({page})=>{
    const errors=[];page.on('pageerror',(e)=>errors.push(e.message));
    await page.setViewportSize({width,height:850});
    await page.goto(base+'/');
    const available=page.locator('#eventList .event-offer-group--available');
    const locked=page.locator('#eventList .event-offer-group--locked');
    await expect(available.getByRole('heading',{name:/可以使用/})).toBeVisible();
    await expect(locked.getByRole('heading',{name:/未解鎖/})).toBeVisible();
    await expect(available.locator('.event-ticket')).toHaveCount(4);
    await expect(locked.locator('.event-ticket')).toHaveCount(1);
    await expect(available).toContainText('好友贈送高階券');
    await expect(available).toContainText('已到期券');
    await expect(available).not.toContainText('金級限定券');
    await expect(locked).toContainText('金級限定券');
    await expect(page.locator('#eventList')).not.toContainText('已轉贈出去的券');
    await expect(locked.getByRole('button',{name:'查看解鎖條件'})).toBeVisible();
    await locked.getByRole('button',{name:'查看解鎖條件'}).click();
    await expect(page.locator('#ticketModalStatus')).toContainText('需要金級會員');
    await expect(page.locator('#ticketModalAction')).toBeDisabled();
    expect(errors).toEqual([]);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
    expect(overflow).toBe(false);
  });
}
test('AC-EVENT-GROUP-004..005: realtime tier changes reclassify cards without stale groups or extra requests',async({page})=>{
  await page.goto(base+'/');
  await expect(page.locator('.event-offer-group--locked .event-ticket')).toHaveCount(1);
  await page.waitForFunction(()=>typeof window.__realtime === 'function');
  await page.evaluate(async()=>{
    window.__offers=window.__offers.map(o=>o.ticket.eventTicketId==='GOLD'?{...o,tierEligible:true,locked:false,canUse:true}:o);
    await window.__realtime();
  });
  await expect(page.locator('.event-offer-group--available .event-ticket')).toHaveCount(5);
  await expect(page.locator('.event-offer-group--locked .event-ticket')).toHaveCount(0);
  await expect(page.locator('.event-offer-group--locked')).toContainText('目前沒有未解鎖的票券');
});
