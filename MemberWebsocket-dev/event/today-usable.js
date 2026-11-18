(() => {
  'use strict';
  let busy=false,queued=false;
  const sessionKey=session=>session?JSON.stringify([
    session.idToken,session.config?.supabaseUrl,session.config?.supabasePublishableKey,
    window.BusinessContext?.slug||session.config?.business||'',
    window.TestModeClient?.getSessionToken?.()||''
  ]):null;
  async function refresh(){
    if(busy){queued=true;return;}
    const session=window.MemberSystem?.getSession?.('event');
    const summary=document.getElementById('eventSummary');
    if(!session||!summary)return;
    busy=true;
    queued=false;
    const key=sessionKey(session);
    const current=()=>key===sessionKey(window.MemberSystem?.getSession?.('event'));
    const controller=new AbortController();
    // timer-policy: deadline; reason=bound stalled summary reads; cleanup=finally; test=event_summary_refresh.test.js
    const deadline=window.setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(`${String(session.config?.supabaseUrl||'').replace(/\/$/,'')}/functions/v1/event-ticket-extension-api`,{
        method:'POST',
        headers:{'Content-Type':'application/json',apikey:String(session.config?.supabasePublishableKey||'')},
        cache:'no-store',
        signal:controller.signal,
        body:JSON.stringify({
          operation:'member.today-usable',
          idToken:session.idToken,
          testSessionToken:String(window.TestModeClient?.getSessionToken?.()||'')
        })
      });
      const payload=await response.json().catch(()=>null);
      if(!current())return;
      if(!response.ok||!payload||payload.ok!==true)throw new Error(payload?.error?.message||'今日可使用張數暫時無法取得');
      const data=payload.data||{};
      let badge=document.getElementById('todayUsableTicketCount');
      if(!badge){
        badge=document.createElement('span');
        badge.id='todayUsableTicketCount';
        badge.className='today-usable-ticket-count';
        summary.parentElement?.append(badge);
      }
      const usableCount=Math.max(0,Number(data.todayUsableCount||0));
      const availableCount=Math.max(0,Number(data.availableTodayCount ?? usableCount));
      const usedTodayCount=Math.max(0,Number(data.usedTodayCount||0));
      const remainingTodayCount=Math.max(0,Number(data.remainingTodayCount ?? usableCount));
      const rawMaxTickets=Number(data.maxTicketsPerDay ?? data.maxTicketsPerRedemption ?? 1);
      const maxTickets=Number.isInteger(rawMaxTickets)&&rawMaxTickets>=0&&rawMaxTickets<=50?rawMaxTickets:1;
      const maxTicketsLabel=maxTickets===0?'不限張數':`${maxTickets} 張`;
      badge.textContent=`今日已使用 ${usedTodayCount} 張 · 每日上限 ${maxTicketsLabel}`;
      badge.dataset.businessDate=String(data.businessDate||'');
      badge.dataset.availableTodayCount=String(availableCount);
      badge.dataset.usedTodayCount=String(usedTodayCount);
      badge.dataset.remainingTodayCount=String(remainingTodayCount);
      badge.dataset.maxTicketsPerDay=String(maxTickets);
      badge.title=maxTickets===0
        ? `今日已使用 ${usedTodayCount} 張，每日上限不限；目前持有 ${availableCount} 張可用活動票券。`
        : `今日已使用 ${usedTodayCount} 張，每日上限 ${maxTickets} 張，剩餘額度 ${remainingTodayCount} 張；目前持有 ${availableCount} 張可用活動票券。`;
      badge.classList.remove('is-error');
    }catch(error){
      if(!current())return;
      let badge=document.getElementById('todayUsableTicketCount');
      if(!badge){
        badge=document.createElement('span');badge.id='todayUsableTicketCount';badge.className='today-usable-ticket-count';
        summary.parentElement?.append(badge);
      }
      badge.textContent='今日使用張數暫時無法取得';
      badge.classList.add('is-error');
    }finally{
      window.clearTimeout(deadline);
      busy=false;
      if(queued){queued=false;void refresh();}
    }
  }
  window.addEventListener('user-tour:ready',(event)=>{if(event?.detail?.surface==='event')void refresh();});
  window.addEventListener('focus',()=>void refresh());
  window.addEventListener('event-ticket:redeemed',()=>void refresh());
  window.addEventListener('event-ticket:changed',()=>void refresh());
  window.addEventListener('event:realtime-refresh',()=>void refresh());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
})();
