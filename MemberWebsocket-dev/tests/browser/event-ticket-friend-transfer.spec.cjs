const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const scripts = { '/event-ticket-ui.js':'event-ticket-ui.js', '/app.js':'event/app.js', '/styles.css':'event/styles.css', '/event-ticket-ui.css':'event-ticket-ui.css', '/theme.css':'theme.css' };
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
    if(id==='eventList') return '<div id="eventList" class="event-list"></div>';
    if(id==='ticketModalUsageMethod') return '<section class="instructions"><strong id="ticketModalUsageMethod"></strong>';
    if(id==='ticketModalUsageInstructions') return '<p id="ticketModalUsageInstructions"></p></section>';
    if(id==='ticketTransferPanel') return [
      '<section id="ticketTransferPanel" class="ticket-transfer-panel" hidden>',
      '<h3>轉贈給好友</h3><label for="ticketTransferFriendSelect">選擇已加入的好友</label>',
      '<select id="ticketTransferFriendSelect"><option value="">載入中</option></select>',
      '<p id="ticketTransferStatus"></p>',
      '<button id="ticketTransferButton" type="button">確認轉贈好友</button></section>'
    ].join('');
    if(['ticketTransferFriendSelect','ticketTransferStatus','ticketTransferButton'].includes(id)) return '';
    if(id==='ticketModalAction'||id==='closeTicketModal'||id.includes('Button')) return '<button id="'+id+'" type="button">'+id+'</button>';
    return '<div id="'+id+'"></div>';
  }).join('\n');
}
const mock = [
  'window.__requests=[];window.__transferred=new URLSearchParams(location.search).get("transferred")==="1";',
  'window.__hasFriends=new URLSearchParams(location.search).get("friends")!=="0";',
  'window.__gifted=new URLSearchParams(location.search).get("gift")==="1";',
  'window.__canUse=new URLSearchParams(location.search).get("use")==="1";',
  'window.TicketBookingChoice={eventOptions:()=>({requiresBooking:false,bookings:[]}),mount(){},selected:()=>"BOOKING1",lock(){}};',
  'window.confirm=(message)=>{window.__confirmMessage=message;return true;};',
  'const ticket={eventTicketId:"EVENT-GIFT-1",title:"好友轉贈測試票券",description:"未使用活動券",',
  'ticketType:"coupon",startsOn:"2026-11-01",endsOn:"2026-12-31",allowedTierKeys:window.__gifted?["gold"]:["general"]};',
  'window.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=>"token",',
  'subscribeRealtime(){},request:async(_cfg,client,token,action,payload={})=>{',
  'window.__requests.push({client,token,action,payload});',
  'if(action==="user.event.bootstrap")return{',
  'profile:{displayName:"測試會員",memberCode:"MEMBERA1"},',
  'usedTickets:window.__transferred?[{ticket,claim:{claimId:"CLAIM-GIFT-1",status:"transferred"},',
  'history:true,transferredOut:true,transferredAt:"2026-11-26T09:20:00Z",transferredToDisplayName:"好友小明",',
  'availability:"transferred",canUse:false,canClaim:false,',
  '},...(new URLSearchParams(location.search).get("multipleTransfer")==="1"?[{ticket,',
  'claim:{claimId:"CLAIM-GIFT-3",status:"transferred"},history:true,transferredOut:true,',
  'transferredAt:"2026-11-26T10:20:00Z",transferredToDisplayName:"好友小華",',
  'availability:"transferred",canUse:false,canClaim:false}]:[])]:[],',
  'usedTicketCount:window.__transferred?(new URLSearchParams(location.search).get("multipleTransfer")==="1"?2:1):0,',
  'bookingSelections:[],',
  'offers:[...(window.__transferred?[]:[{ticket,claim:{claimId:"CLAIM-GIFT-1",status:"available",ticketType:"coupon"},',
  'availability:"active",tierEligible:true,canClaim:false,canUse:window.__canUse,history:false,receivedAsGift:window.__gifted,',
  'giftFromDisplayName:window.__gifted?"好友小華":"",giftTransferredAt:window.__gifted?"2026-11-25T10:45:00Z":"",',
  'transferredOut:false}]),',
  '...(new URLSearchParams(location.search).get("multiple")==="1"?[{ticket,claim:{claimId:"CLAIM-GIFT-2",status:"available",ticketType:"coupon"},',
  'availability:"active",tierEligible:true,canClaim:false,canUse:false,history:false,receivedAsGift:true,',
  'giftFromDisplayName:"好友小華",giftTransferredAt:"2026-11-25T10:45:00Z",transferredOut:false}]:[])]};',
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
      response.writeHead(200,{'Content-Type':requestPath.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});
      response.end(fs.readFileSync(path.join(root,scripts[requestPath]),'utf8'));
      return;
    }
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    response.end([
      '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
      '<style>.hidden{display:none!important}</style>',
      '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/event-ticket-ui.css">',
      '<script>',mock,'</script>',
      '<script defer src="/event-ticket-ui.js"></script><script defer src="/app.js"></script></head><body>',
      nodes(ids.slice(0,ids.indexOf('ticketModal'))),
      '<div id="syncNotice"></div>',
      '<div id="ticketModal" class="ticket-modal hidden"><div class="ticket-modal-card">',
      nodes(ids.slice(ids.indexOf('ticketModal')+1)),
      '</div></div></body></html>'
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
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(0);
  await expect(page.locator('#usedTicketHistory')).toBeVisible();
  await expect(page.locator('#usedTicketList .event-history-item')).toHaveCount(1);
  await expect(page.locator('#usedTicketList')).toContainText('已轉贈');
  await expect(page.locator('#usedTicketList')).toContainText('好友小明');
  const transferred=await page.evaluate(()=>window.__requests.filter(r=>r.action==='user.event.ticket.transfer'));
  expect(transferred).toHaveLength(1);
  expect(transferred[0].client).toBe('event');
  expect(transferred[0].payload.claimId).toBe('CLAIM-GIFT-1');
  expect(transferred[0].payload.receiverMemberCode).toBe('MEMBERB1');
  expect(transferred[0].payload.requestId).toMatch(/^[a-f0-9]{32}$/);
  expect(errors).toEqual([]);
});
test('AC-GIFT-HISTORY-001: transferred ticket stays only in history after a fresh page load',async({page})=>{
  await page.goto(base+'/?transferred=1');
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(0);
  await expect(page.locator('#usedTicketList .event-history-item')).toHaveCount(1);
  await expect(page.locator('#usedTicketHistorySummary')).toHaveText('共 1 筆票券紀錄');
  await expect(page.locator('#usedTicketList')).toContainText('轉贈於 2026/11/26 17:20');
  await page.locator('#usedTicketList .event-history-button').click();
  await expect(page.locator('#ticketModalDate')).toContainText('已轉贈');
  await expect(page.locator('#ticketModalDate')).toContainText('好友小明');
  await expect(page.locator('#ticketModalAction')).toBeHidden();
  await expect(page.locator('#ticketTransferPanel')).toBeHidden();
  await page.reload();
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(0);
  await expect(page.locator('#usedTicketList .event-history-item')).toHaveCount(1);
});

test('AC-GIFT-HISTORY-002: a different physical claim stays usable after another claim was gifted',async({page})=>{
  await page.goto(base+'/?transferred=1&multiple=1');
  const cards=page.locator('#eventList .event-ticket');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('好友小華');
  await expect(page.locator('#usedTicketList .event-history-item')).toHaveCount(1);
  await expect(page.locator('#usedTicketList')).toContainText('好友小明');
});

test('AC-GIFT-HISTORY-003: multiple transfers of the same campaign keep separate history entries',async({page})=>{
  await page.goto(base+'/?transferred=1&multipleTransfer=1');
  const history=page.locator('#usedTicketList .event-history-item');
  await expect(history).toHaveCount(2);
  await history.nth(1).locator('button').click();
  await expect(page.locator('#ticketModalDate')).toContainText('好友小華');
  await page.locator('#closeTicketModal').click();
  await history.nth(0).locator('button').click();
  await expect(page.locator('#ticketModalDate')).toContainText('好友小明');
  await expect(page.locator('#eventList .event-ticket')).toHaveCount(0);
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

test('AC-GIFT-UI-004: gifted ticket shows sender and Taipei transfer time on card and modal',async({page})=>{
  await page.goto(base+'/?gift=1');
  const card=page.locator('#eventList .event-ticket');
  await expect(card).toContainText('轉贈者');
  await expect(card).toContainText('好友小華');
  await expect(card).toContainText('轉贈時間');
  await expect(card).toContainText('2026/11/25 18:45');
  await card.locator('button').first().click();
  await expect(page.locator('[data-ticket-gift-info]')).toContainText('轉贈者：好友小華');
  await expect(page.locator('[data-ticket-gift-info]')).toContainText('2026/11/25 18:45');
});

test('AC-GIFT-UI-005: two physical claims of one campaign open their own provenance',async({page})=>{
  await page.goto(base+'/?multiple=1');
  const cards=page.locator('#eventList .event-ticket');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).not.toContainText('轉贈者');
  await expect(cards.nth(1)).toContainText('好友小華');
  await cards.nth(1).locator('button').first().click();
  await expect(page.locator('[data-ticket-gift-info]')).toContainText('好友小華');
  await page.locator('#closeTicketModal').click();
  await cards.nth(0).locator('button').first().click();
  await expect(page.locator('[data-ticket-gift-info]')).toHaveClass(/hidden/);
  await expect(page.getByRole('button',{name:'轉贈好友'})).toHaveCount(1);
});

test('AC-TICKET-ACTION-001: using a ticket opens only the redemption flow',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?friends=1&use=1');
  const actions=page.locator('#eventList .event-ticket-action-buttons');
  await expect(actions.locator('button')).toHaveCount(2);
  await expect(actions.locator('[data-ticket-action="use"]')).toHaveText('使用票券');
  await expect(actions.locator('[data-ticket-action="transfer"]')).toHaveText('轉贈好友');
  await actions.locator('[data-ticket-action="use"]').click();
  await expect(page.locator('#ticketModal')).toHaveAttribute('data-ticket-mode','use');
  await expect(page.locator('#ticketModalAction')).toBeVisible();
  await expect(page.locator('#ticketTransferPanel')).toBeHidden();
  expect(await page.evaluate(()=>window.__requests.filter(r=>r.action==='member.friend.list'))).toHaveLength(0);
  expect(await page.evaluate(()=>window.__requests.filter(r=>r.action==='user.event.ticket.transfer'))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('AC-TICKET-ACTION-002: gifting opens only the friend transfer flow and preserves separation after close',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?friends=1&use=1');
  const actions=page.locator('#eventList .event-ticket-action-buttons');
  await actions.locator('[data-ticket-action="transfer"]').click();
  await expect(page.locator('#ticketModal')).toHaveAttribute('data-ticket-mode','transfer');
  await expect(page.locator('#ticketTransferPanel')).toBeVisible();
  await expect(page.locator('#ticketModalAction')).toBeHidden();
  await expect(page.locator('[data-ticket-booking-choice]')).toBeHidden();
  await expect(page.locator('#ticketTransferStatus')).toContainText('限轉贈一次');
  await expect(page.locator('#ticketModalStatus')).toContainText('轉贈後不可撤銷');
  const requests=await page.evaluate(()=>window.__requests.filter(r=>r.action==='member.friend.list'));
  expect(requests).toHaveLength(1);
  await page.locator('#closeTicketModal').click();
  await actions.locator('[data-ticket-action="use"]').click();
  await expect(page.locator('#ticketModal')).toHaveAttribute('data-ticket-mode','use');
  await expect(page.locator('#ticketTransferPanel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('AC-TICKET-ACTION-003: responsive actions are stacked on phones and side by side on desktop',async({page})=>{
  await page.setViewportSize({width:375,height:812});
  await page.goto(base+'/?friends=1&use=1');
  const use=page.locator('[data-ticket-action="use"]');
  const transfer=page.locator('[data-ticket-action="transfer"]');
  const phoneUse=await use.boundingBox(),phoneTransfer=await transfer.boundingBox();
  expect(phoneUse&&phoneTransfer).toBeTruthy();
  expect(phoneTransfer.y).toBeGreaterThanOrEqual(phoneUse.y+phoneUse.height-1);
  expect(phoneUse.width).toBeGreaterThan(250);
  await page.setViewportSize({width:1200,height:900});
  const desktopUse=await use.boundingBox(),desktopTransfer=await transfer.boundingBox();
  expect(desktopUse&&desktopTransfer).toBeTruthy();
  expect(Math.abs(desktopUse.y-desktopTransfer.y)).toBeLessThan(3);
  expect(desktopTransfer.x).toBeGreaterThan(desktopUse.x+desktopUse.width-1);
});

function uiContrast(foreground, background) {
  const luminance = (color) => {
    const rgb = color.match(/[0-9.]+/g)?.slice(0, 3).map(Number);
    if (!rgb || rgb.length !== 3) throw new Error('Unexpected CSS color: ' + color);
    const channels = rgb.map(value => {
      const component = value / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const high = Math.max(luminance(foreground), luminance(background));
  const low = Math.min(luminance(foreground), luminance(background));
  return (high + 0.05) / (low + 0.05);
}

test('AC-TICKET-VISUAL-001: transfer is a readable, filled action distinct from use in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(base + '/?friends=1&use=1');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const styles = await page.evaluate(() => {
      const use = document.querySelector('[data-ticket-action="use"]');
      const gift = document.querySelector('[data-ticket-action="transfer"]');
      const primary = getComputedStyle(use);
      const secondary = getComputedStyle(gift);
      return {
        useColor: primary.color, useBackground: primary.backgroundColor,
        transferColor: secondary.color, transferBackground: secondary.backgroundColor,
        transferHeight: gift.getBoundingClientRect().height,
        transferWidth: gift.getBoundingClientRect().width,
        fontSize: Number.parseFloat(secondary.fontSize)
      };
    });
    expect(styles.transferBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.transferBackground).not.toBe(styles.useBackground);
    expect(uiContrast(styles.transferColor, styles.transferBackground)).toBeGreaterThanOrEqual(4.5);
    expect(uiContrast(styles.useColor, styles.useBackground)).toBeGreaterThanOrEqual(4.5);
    expect(styles.transferHeight).toBeGreaterThanOrEqual(48);
    expect(styles.transferWidth).toBeGreaterThan(250);
    expect(styles.fontSize).toBeGreaterThanOrEqual(13);
  }
});

test('AC-TICKET-VISUAL-002: dark mode has legible ticket, transfer and usage surfaces', async ({ page }) => {
  await page.goto(base + '/?friends=1&use=1');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const transfer = page.locator('[data-ticket-action="transfer"]');
  await transfer.click();
  await expect(page.locator('#ticketTransferPanel')).toBeVisible();
  const transferTheme = await page.evaluate(() => {
    const panel = document.querySelector('#ticketTransferPanel');
    const heading = panel.querySelector('h3');
    const card = document.querySelector('.ticket-modal-card');
    const state = document.querySelector('.event-ticket-state');
    return {
      panelBackground: getComputedStyle(panel).backgroundColor,
      panelText: getComputedStyle(heading).color,
      cardBackground: getComputedStyle(card).backgroundColor,
      stateBackground: getComputedStyle(state).backgroundColor,
      stateText: getComputedStyle(state).color
    };
  });
  expect(uiContrast(transferTheme.panelText, transferTheme.panelBackground)).toBeGreaterThanOrEqual(4.5);
  expect(uiContrast(transferTheme.stateText, transferTheme.stateBackground)).toBeGreaterThanOrEqual(4.5);
  expect(uiContrast(transferTheme.panelBackground, 'rgb(255, 255, 255)')).toBeGreaterThan(5);
  expect(uiContrast(transferTheme.cardBackground, 'rgb(255, 255, 255)')).toBeGreaterThan(5);
  await page.locator('#closeTicketModal').click();
  await page.locator('[data-ticket-action="use"]').click();
  const usageTheme = await page.evaluate(() => {
    const instructions = document.querySelector('.instructions');
    const description = instructions.querySelector('strong');
    return { background: getComputedStyle(instructions).backgroundColor, text: getComputedStyle(description).color };
  });
  expect(uiContrast(usageTheme.text, usageTheme.background)).toBeGreaterThanOrEqual(4.5);
  expect(uiContrast(usageTheme.background, 'rgb(255, 255, 255)')).toBeGreaterThan(5);
});
