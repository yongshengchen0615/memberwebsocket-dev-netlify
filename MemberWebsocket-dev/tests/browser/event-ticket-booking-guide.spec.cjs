const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const files = {
  '/ticket-booking-choice.js': 'ticket-booking-choice.js',
  '/event-ticket-ui.js': 'event-ticket-ui.js',
  '/event-app.js': 'event/app.js',
  '/booking-benefits.js': 'booking/booking-benefits.js',
};
const eventStub = String.raw`
  window.__eventWrites = 0;
  window.BusinessContext = {slug:'shop-a',allows:()=>true,allowsBenefit:()=>true};
  window.MembershipProgress = {render(){}};
  window.MemberSystem = {
    bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=> 'test-token',subscribeRealtime(){},
    request:async(_config,_kind,_token,action)=>{
      if(action==='user.event.bootstrap')return {profile:{displayName:'QA會員'},usedTickets:[],bookingSelections:[],offers:[{
        ticket:{eventTicketId:'EVENT-GUIDED',ticketType:'coupon',title:'限預約活動券',description:'預約後可使用',
          minBookingAmountMode:'total',minBookingAmount:300,
          minBookingAmountLabel:'一般預約滿 NT$300',startsOn:'2026-11-01',endsOn:'2026-12-31'},
        claim:{claimId:'EC-GUIDED',status:'available'},canClaim:false,canUse:false,
        tierEligible:true,availability:'active',eligibleBookings:[],
      }]};
      window.__eventWrites++;
      throw Error('Unexpected event mutation: '+action);
    },
  };
`;
const bookingStub = String.raw`
  window.__claimCalls=0;
  window.MemberUI = {pointCardStyleKey:()=>'',pointTicketDetails:()=>document.createElement('div')};
  window.BookingSystem = {
    claimEventTicket:()=>{window.__claimCalls++;throw Error('Ticket claiming must not happen');},
    bookingBenefits:async()=>({eventTicketMaxPerDay:2,pointTicketMaxPerRedemption:2,items:[
      {kind:'event',id:'EVENT-GUIDED',title:'限預約活動券',
        selectionId:'EC-GUIDED',selectable:true,statusLabel:'可使用',
        conditionLabel:'符合本次預約服務條件'}
    ]}),
  };
  window.addEventListener('load',()=>window.BookingBenefits.start({},'qa'));
`;
let server, base;
test.beforeAll(async () => {
  server=http.createServer((req,res) => {
    const url=new URL(req.url,'http://127.0.0.1');
    if(files[url.pathname]){
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
      res.end(fs.readFileSync(path.join(root,files[url.pathname]),'utf8'));
      return;
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    if(url.pathname==='/event/') {
      let html=fs.readFileSync(path.join(root,'event/index.html'),'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
        // The fixture injects a synthetic inline auth stub; strip only the
        // fixture page's restrictive CSP, never alter the deployed application.
        .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,'')
        .replace(/<link\b[^>]*>/gi,'');
      html=html.replace('</head>',
        '<style>.hidden{display:none!important}</style><script>'+eventStub+'</script>'+
        '<script defer src="/ticket-booking-choice.js"></script>'+
        '<script defer src="/event-ticket-ui.js"></script>'+
        '<script defer src="/event-app.js"></script></head>');
      res.end(html);
      return;
    }
    if(url.pathname==='/booking/') {
      res.end('<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'+
        '<style>.hidden{display:none!important}</style>'+
        '<script>'+bookingStub+'</script><script defer src="/booking-benefits.js"></script></head>'+
        '<body><aside id="bookingTicketGuide" class="hidden"><strong>活動票券預約使用步驟</strong>'+
        '<p id="bookingTicketGuideText"></p></aside>'+
        '<section id="bookingBenefits"><p id="bookingBenefitsStatus"></p><button id="bookingBenefitsRetry"></button>'+
        '<div id="bookingBenefitsList"></div></section></body></html>');
      return;
    }
    res.writeHead(404);res.end('not found');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{if(server)await new Promise(resolve=>server.close(resolve));});
for(const width of [390,1280]){
  test('AC-BOOKING-GUIDE browser '+width+'px: follow booking link and select already issued ticket without claiming',async({page})=>{
    await page.setViewportSize({width,height:850});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/event/?business=shop-a&token=sensitive');
    await expect(page.locator('#eventList .event-ticket')).toHaveCount(1);
    const guide=page.locator('#eventList [data-ticket-action="booking-guide"]');
    await expect(guide).toHaveText('前往預約使用');
    const target=new URL(await guide.getAttribute('href'));
    expect(target.pathname).toBe('/booking/');
    expect(target.searchParams.get('business')).toBe('shop-a');
    expect(target.searchParams.get('eventTicketId')).toBe('EVENT-GUIDED');
    expect(target.searchParams.has('token')).toBe(false);
    await guide.click();
    await expect(page).toHaveURL(/\/booking\/\?business=shop-a&eventTicketId=EVENT-GUIDED/);
    await expect(page.locator('#bookingTicketGuide')).toBeVisible();
    await expect(page.locator('#bookingTicketGuideText')).toContainText('限預約活動券');
    const card=page.locator('#bookingBenefitsList .booking-benefit.is-guided-ticket');
    await expect(card).toHaveCount(1);
    await card.locator('input[data-booking-benefit-kind="event"][data-booking-benefit-id="EC-GUIDED"]').check();
    expect(await page.evaluate(()=>window.BookingBenefits.selectionPayload())).toEqual([{kind:'event',id:'EC-GUIDED'}]);
    expect(await page.evaluate(()=>window.__claimCalls)).toBe(0);
    expect(errors).toEqual([]);
  });
}
