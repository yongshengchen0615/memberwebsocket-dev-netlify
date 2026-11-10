const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const scripts = { '/event-ticket-ui.js':'event-ticket-ui.js', '/app.js':'event/app.js' };
const ids = [
  'app','loadingView','loadingProgress','loadingProgressBar','loadingProgressText',
  'loadingStatus','errorView','errorTitle','errorMessage','joinMemberButton','retryButton',
  'eventView','displayName','membershipProgress','eventSummary','eventList','emptyView',
  'usedTicketHistory','usedTicketHistorySummary','usedTicketList',
  'ticketModal','closeTicketModal','ticketModalType','ticketModalTitle','ticketModalDate',
  'ticketModalDescription','ticketModalUsageMethod','ticketModalUsageInstructions',
  'ticketModalServiceRequirement','ticketModalAmountRequirement','ticketModalPrizes',
  'ticketModalStatus','ticketModalProcessing','ticketModalProcessingText','ticketModalResult',
  'ticketModalAction','refreshTicketButton','ticketModalMessage','ticketModalLocationStatus',
  'ticketModalLocationButton'
];
const nodes = (names) => names.map((id) => {
  const isButton = id.includes('Button') || ['closeTicketModal','joinMemberButton','retryButton'].includes(id);
  return isButton ? '<button type="button" id="'+id+'">'+id+'</button>' : '<div id="'+id+'"></div>';
}).join('\n');

const fixture = [
  '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<style>.hidden{display:none !important}.event-ticket{margin:12px;padding:12px;border:1px solid #888}',
  '.event-ticket-meta{display:grid;gap:4px}.event-ticket-meta span{display:block}',
  '#ticketModal:not(.hidden){margin-top:12px;border:1px solid #888;padding:12px}</style>',
  '<script>window.MemberSystem = {',
  'bindDialogKeyboard() {}, loadConfig: async () => ({}),',
  'signIn: async () => "synthetic-member-token", subscribeRealtime() {},',
  'request: async () => ({ profile:{displayName:"QA 會員"},usedTickets:[],bookingSelections:[],',
  'offers:[',
  '{ticket:{eventTicketId:"TOTAL",title:"總額活動券",ticketType:"coupon",description:"滿額才能使用",',
  'minBookingAmountLabel:"一般預約總金額滿 NT$1,800",startsOn:"2026-11-10",endsOn:"2026-12-31"},',
  'claim:null,availability:"active",canClaim:true,tierEligible:true},',
  '{ticket:{eventTicketId:"SELECTED",title:"指定項目活動券",ticketType:"coupon",description:"限定項目合計",',
  'minBookingAmountLabel:"一般預約指定項目「按摩 60 分鐘、足浴 30 分鐘」合計滿 NT$880",',
  'startsOn:"2026-11-10",endsOn:"2026-12-31"},claim:null,availability:"active",canClaim:true,tierEligible:true},',
  '{ticket:{eventTicketId:"LEGACY",title:"舊活動券",ticketType:"coupon",description:"只有預約項目條件",',
  'requiredServiceRequirementLabel:"需預約「頭部舒壓」項目",startsOn:"2026-11-10",endsOn:"2026-12-31"},',
  'claim:null,availability:"active",canClaim:true,tierEligible:true}',
  ']})};',
  'window.MembershipProgress={render(){}};</script>',
  '<script defer src="/event-ticket-ui.js"></script><script defer src="/app.js"></script></head><body>',
  nodes(ids.slice(0,ids.indexOf('ticketModal'))),
  '<div id="syncNotice"></div>',
  '<div id="ticketModal" class="hidden">'+nodes(ids.slice(ids.indexOf('ticketModal')+1))+'</div>',
  '</body></html>'
].join('\n');

let server, base;
test.beforeAll(async () => {
  server=http.createServer((request,response)=>{
    if (scripts[request.url]) {
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
      response.end(fs.readFileSync(path.join(root,scripts[request.url]),'utf8'));
      return;
    }
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    response.end(fixture);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{
  if (server) await new Promise(resolve=>server.close(resolve));
});

for(const width of [390,1280]){
  test('AC-UI-001..003: ticket card and details show amount rules without an empty legacy label at '+width+'px',async({page})=>{
    await page.setViewportSize({width,height:850});
    const errors=[];
    page.on('pageerror',error=>errors.push(String(error.message||error)));
    await page.goto(base+'/');
    await expect(page.locator('#eventList .event-ticket')).toHaveCount(3);
    const cards=page.locator('#eventList .event-ticket');
    await expect(cards.nth(0)).toContainText('金額使用條件');
    await expect(cards.nth(0)).toContainText('一般預約總金額滿 NT$1,800');
    await expect(cards.nth(1)).toContainText('一般預約指定項目「按摩 60 分鐘、足浴 30 分鐘」合計滿 NT$880');
    await expect(cards.nth(2)).not.toContainText('金額使用條件');
    await expect(cards.nth(2)).toContainText('預約項目條件');
    await page.locator('[data-event-ticket-id="TOTAL"]').click();
    await expect(page.locator('#ticketModalAmountRequirement')).toBeVisible();
    await expect(page.locator('#ticketModalAmountRequirement')).toContainText('一般預約總金額滿 NT$1,800');
    await page.locator('#closeTicketModal').click();
    await page.locator('[data-event-ticket-id="SELECTED"]').click();
    await expect(page.locator('#ticketModalAmountRequirement')).toContainText('按摩 60 分鐘、足浴 30 分鐘');
    await page.locator('#closeTicketModal').click();
    await page.locator('[data-event-ticket-id="LEGACY"]').click();
    await expect(page.locator('#ticketModalAmountRequirement')).toBeHidden();
    await expect(page.locator('#ticketModalServiceRequirement')).toContainText('頭部舒壓');
    expect(errors).toEqual([]);
  });
}
