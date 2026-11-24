// Browser acceptance: real Chromium rendering of individual issued expiry.
const {test,expect}=require('playwright/test');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const resources={'/event-ticket-ui.js':'event-ticket-ui.js','/app.js':'event/app.js'};
const ids=[
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
const nodes=(list)=>list.map(id=>{
 if(id==='ticketTransferFriendSelect')return '<select id="ticketTransferFriendSelect"><option value="">選擇好友</option></select>';
 if(id==='ticketTransferPanel')return '<section id="ticketTransferPanel" hidden></section>';
 if(id.includes('Button')||['closeTicketModal','joinMemberButton','retryButton'].includes(id))return '<button id="'+id+'"></button>';
 return '<div id="'+id+'"></div>';
}).join('\n');
const fixture=[
 '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
 '<meta name="viewport" content="width=device-width,initial-scale=1">',
 '<style>.hidden{display:none!important}.event-ticket{margin:12px;padding:12px;border:1px solid #888}.event-ticket-meta{display:grid;gap:4px}</style>',
 '<script>window.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=>"synthetic-token",subscribeRealtime(){},request:async()=>({',
 'profile:{displayName:"QA"},usedTickets:[],bookingSelections:[],offers:[',
 '{ticket:{eventTicketId:"FIX",title:"舊固定期限券",description:"保留既有固定日期使用期限",ticketType:"coupon",startsOn:"2026-11-01",endsOn:"2026-12-31"},',
 'claim:{claimId:"EC-FIX",status:"claimed"},availability:"active",canUse:true,tierEligible:true},',
 '{ticket:{eventTicketId:"REL",title:"個人相對期限券",description:"依會員獲得時間計算",ticketType:"coupon",validityMode:"relative",validityDays:30},',
 'claim:{claimId:"EC-REL",status:"claimed",expiresAt:"2026-12-24T02:00:00Z"},availability:"active",canUse:true,tierEligible:true},',
 '{ticket:{eventTicketId:"OLD",title:"已經到期券",description:"到期後不得再核銷",ticketType:"coupon",validityMode:"relative",validityDays:1},',
 'claim:{claimId:"EC-OLD",status:"claimed",expiresAt:"2020-01-01T00:00:00Z"},availability:"expired",canUse:false,tierEligible:true}',
 ']})};window.MembershipProgress={render(){}};</script>',
 '<script defer src="/event-ticket-ui.js"></script><script defer src="/app.js"></script></head><body>',
 nodes(ids.slice(0,ids.indexOf('ticketModal'))),'<div id="syncNotice"></div>',
 '<div id="ticketModal" class="hidden">'+nodes(ids.slice(ids.indexOf('ticketModal')+1))+'</div>',
 '</body></html>'
].join('\n');
let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  if(resources[req.url]){
   res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
   res.end(fs.readFileSync(path.join(root,resources[req.url]),'utf8'));return;
  }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{if(server)await new Promise(resolve=>server.close(resolve));});
for(const width of [390,1280]){
 test('AC-REL-UI-001..004: claim deadline shown in card and modal without mislabelling unlimited '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:860});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(3);
  const fixed=page.locator('#eventList .event-ticket').filter({hasText:'舊固定期限券'});
  const relative=page.locator('#eventList .event-ticket').filter({hasText:'個人相對期限券'});
  const expired=page.locator('#eventList .event-ticket').filter({hasText:'已經到期券'});
  await expect(fixed).toContainText('活動期間');
  await expect(fixed).toContainText('2026-12-31');
  await expect(relative).toContainText('票券期限');
  await expect(relative).toContainText('獲得後 30 天有效');
  await expect(relative).toContainText('2026');
  await expect(relative).not.toContainText('不限期');
  await expect(expired).toContainText('已到期');
  await page.locator('[data-event-ticket-id="REL"]').first().click();
  await expect(page.locator('#ticketModalDate')).toContainText('獲得後 30 天有效');
  await expect(page.locator('#ticketModalDate')).toContainText('2026');
  await page.locator('#closeTicketModal').click();
  await page.locator('[data-event-ticket-id="OLD"]').first().click();
  await expect(page.locator('#ticketModalStatus')).toContainText('已超過獲得後使用期限');
  expect(errors).toEqual([]);
 });
}
