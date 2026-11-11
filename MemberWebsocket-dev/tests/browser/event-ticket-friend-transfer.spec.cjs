const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const scripts = { '/event-ticket-ui.js':'event-ticket-ui.js', '/app.js':'event/app.js' };
const ids = [
  'app','loadingView','loadingProgress','loadingProgressBar','loadingProgressText','loadingStatus',
  'errorView','errorTitle','errorMessage','joinMemberButton','retryButton','eventView',
  'displayName','membershipProgress','eventSummary','eventList','emptyView',
  'usedTicketHistory','usedTicketHistorySummary','usedTicketList','ticketModal',
  'closeTicketModal','ticketModalType','ticketModalTitle','ticketModalDate','ticketModalDescription',
  'ticketModalUsageMethod','ticketModalUsageInstructions','ticketModalServiceRequirement',
  'ticketModalAmountRequirement','ticketModalPrizes','ticketModalStatus',
  'ticketModalProcessing','ticketModalProcessingText','ticketModalResult',
  'ticketModalAction','refreshTicketButton','ticketModalMessage',
  'ticketModalLocationStatus','ticketModalLocationButton','ticketTransferPanel',
  'ticketTransferFriendSelect','ticketTransferStatus','ticketTransferButton'
];
function nodes(names) {
  return names.map(id => {
    if(id==='ticketTransferFriendSelect') return '<select id="'+id+'"><option value="">載入中</option></select>';
    if(id==='ticketTransferPanel') return '<section id="'+id+'" hidden></section>';
    if(id==='ticketTransferButton'||id==='ticketModalAction'||id==='closeTicketModal'||id.includes('Button')) return '<button id="'+id+'" type="button">'+id+'</button>';
    return '<div id="'+id+'"></div>';
  }).join('\n');
}
const mock = [
  'window.__requests=[];window.__transferred=false;',
  'window.__hasFriends=new URLSearchParams(location.search).get("friends")!=="0";',
  'window.__gifted=new URLSearchParams(location.search).get("gift")==="1";',
  'window.confirm=(message)=>{window.__confirmMessage=message;return true;};'
  'const ticket={eventTicketId:"EVENT-GIFT-1",title:"好友轉贈測試票券",description:"未使用活動券",',
  'ticketType:"coupon",startsOn:"2026-11-01",endsOn:"2026-12-31",allowedTierKeys:window.__gifted?["gold"]:["general"]};',
  'window.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=>"token",',
  'subscribeRealtime(){},request:async(_cfg,client,token,action,payload={})=>{',
  'window.__requests.push({client,token,action,payload});',
  'if(action==="user.event.bootstrap")return{',
  'profile:{displayName:"測試會員",memberCode:"MEMBERA1"},',
  'usedTickets:[],usedTicketCount:0,bookingSelections:[],',
  'offers:[{ticket,claim:window.__transferred?null:{claimId:"CLAIM-GIFT-1",status:"available",ticketType:"coupon"},',
  'availability:"active",tierEligible:true,canClaim:false,canUse:false,history:false,receivedAsGift:window.__gifted,transferredOut:window.__transferred}]};',
  'if(action==="member.friend.list")return{friends:window.__hasFriends?[',
  '{memberCode:"MEMBERB1",displayName:"好友小明",status:"accepted"},',
  '{memberCode:"MEMBERC1",displayName:"未接受",status:"pending"},',
  '{memberCode:"MEMBERD1",displayName:"已封鎖",status:"blocked"}',
  ']:[{memberCode:"MEMBERC1",displayName:"未接受",status:"pending"}]};',
  'if(action==="user.event.ticket.transfer"){window.__transferred=true;',
  'return{claimId:"CLAIM-GIFT-1",alreadyTransferred:false};}',
  'throw Error("Unexpected action: "+action);}};',
  'window.MembershipProgress={render(){}};'
].join('\n');
let server, base;
test.beforeAll(async () => {
  server=http.createServer((request,response)=>{
    const requestPath=request.url.split('?')[0];
    if(scripts[requestPath]){
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
      response.end(fs.readFileSync(path.join(root,scripts[requestPath]),'utf8'));
      return;
    }
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    response.end([
      '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
      '<style>.hidden{display:none!important}.event-ticket{border:1px solid #ccc;padding:10px}</style>',
      '<script>',mock,'</script>',
      '<script defer src="/event-ticket-ui.js"></script><script defer src="/app.js"></script></head><body>',
      nodes(ids.slice(0,ids.indexOf('ticketModal'))),
      '<div id="syncNotice"></div>',
      '<div id="ticketModal" class="hidden">',
      nodes(ids.slice(ids.indexOf('ticketModal')+1)),
      '</div></body></html>'
    ].join('\n'));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve));
});
test('AC-GIFT-UI-001: only accepted friend can be chosen, and ticket transfers once',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?friends=1');
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'轉贈好友'})).toBeVisible();
  await page.getByRole('button',{name:'轉贈好友'}).click();
  const select=page.locator('#ticketTransferFriendSelect');
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option[value=MEMBERB1]')).toHaveCount(1);
  await expect(select.locator('option[value=MEMBERC1]')).toHaveCount(0);
  await expect(select.locator('option[value=MEMBERD1]')).toHaveCount(0);
  await select.selectOption('MEMBERB1');
  await expect(page.locator('#ticketTransferButton')).toBeEnabled();
  await expect(page.locator('#ticketTransferStatus')).toContainText('限轉贈一次');
  await expect(page.locator('#ticketTransferStatus')).toContainText('不受原票券會員階級限制');
  await page.locator('#ticketTransferButton').click();
  const disclosure=await page.evaluate(()=>window.__confirmMessage);
  expect(disclosure).toContain('每張票券限轉贈一次');
  expect(disclosure).toContain('無會員階級使用限制');
  expect(disclosure).toContain('不可再次轉贈');
  await expect(page.locator('#eventList')).toContainText('已轉贈');
  const transferred=await page.evaluate(()=>window.__requests.filter(r=>r.action==='user.event.ticket.transfer'));
  expect(transferred).toHaveLength(1);
  expect(transferred[0].client).toBe('event');
  expect(transferred[0].payload.claimId).toBe('CLAIM-GIFT-1');
  expect(transferred[0].payload.receiverMemberCode).toBe('MEMBERB1');
  expect(transferred[0].payload.requestId).toMatch(/^[a-f0-9]{32}$/);
  expect(errors).toEqual([]);
});
test('AC-GIFT-UI-002: without accepted friends the transfer stays disabled',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?friends=0');
  await expect(page.getByRole('button',{name:'轉贈好友'})).toBeVisible();
  await page.getByRole('button',{name:'轉贈好友'}).click();
  await expect(page.locator('#ticketTransferStatus')).toContainText('沒有已接受的好友');
  await expect(page.locator('#ticketTransferButton')).toBeDisabled();
  await expect(page.locator('#ticketTransferFriendSelect option')).toHaveCount(1);
  expect(await page.evaluate(()=>window.__requests.filter(r=>r.action==='user.event.ticket.transfer'))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('AC-GIFT-UI-003: a previously received gift is tier-exempt and cannot be transferred again',async({page})=>{
  await page.goto(base+'/?gift=1');
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'轉贈好友'})).toHaveCount(0);
  await page.locator('#eventList button').first().click();
  await expect(page.locator('#ticketModalStatus')).toContainText('不受會員階級限制');
  expect(await page.evaluate(()=>window.__requests.filter(r=>r.action==='user.event.ticket.transfer'))).toHaveLength(0);
});
