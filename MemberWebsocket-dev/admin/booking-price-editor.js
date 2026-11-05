(() => {
  'use strict';
  let closeCurrent=null;
  const money=value=>new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',maximumFractionDigits:0}).format(value);
  const time=value=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  const local=value=>{
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  async function open({service,request,onSaved=async()=>{}}) {
    closeCurrent?.();
    const opener=document.activeElement;
    const overlay=document.createElement('div');overlay.className='booking-price-overlay';
    const dialog=document.createElement('section');dialog.className='booking-price-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','bookingPriceHeading');
    dialog.innerHTML='<div class="booking-price-heading"><h3 id="bookingPriceHeading"></h3><button type="button" data-close aria-label="關閉價格設定">×</button></div><p data-current></p><form class="booking-admin-form"><label>新價格（NT$）<input name="priceAmount" type="number" min="0" max="10000000" step="1" required></label><label>發佈方式<select name="mode"><option value="immediate">立即發佈</option><option value="scheduled">指定時間發佈</option></select></label><label data-time class="hidden">生效時間（台北時間 UTC+08:00）<input name="publishAt" type="datetime-local" step="60"></label><p class="booking-price-hint">立即調價會保留其他未來排程。已成立預約保留原價格。</p><div role="status" aria-live="polite" data-message></div><div class="booking-price-form-actions"><button type="button" data-reset class="button button-outline hidden">取消改期</button><button type="submit" class="button button-dark">立即發佈</button></div></form><section aria-label="價格發佈紀錄"><h4>待發佈與價格歷史</h4><div data-history>載入中…</div></section>';
    dialog.querySelector('h3').textContent=`${service.title}｜價格設定`;
    dialog.querySelector('[data-current]').textContent=`目前價格 ${money(service.priceAmount)}`;
    overlay.append(dialog);document.body.append(overlay);
    const form=dialog.querySelector('form'),price=form.elements.priceAmount,mode=form.elements.mode,date=form.elements.publishAt,submit=form.querySelector('[type="submit"]'),message=form.querySelector('[data-message]'),history=dialog.querySelector('[data-history]'),reset=form.querySelector('[data-reset]');
    price.value=String(service.priceAmount);let editing=null,busy=false,pending=null;
    const close=()=>{if(busy)return;document.removeEventListener('keydown',key);overlay.remove();if(closeCurrent===close)closeCurrent=null;if(opener?.isConnected)opener.focus();};
    const key=e=>{
      if(e.key==='Escape'){e.preventDefault();close();}
      if(e.key==='Tab'){
        const focusable=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(x=>!x.closest('.hidden'));
        if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    };
    closeCurrent=close;document.addEventListener('keydown',key);dialog.querySelector('[data-close]').addEventListener('click',close);
    overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
    const updateMode=()=>{const scheduled=mode.value==='scheduled';form.querySelector('[data-time]').classList.toggle('hidden',!scheduled);date.required=scheduled;submit.textContent=editing?'儲存改期':scheduled?'設定發佈時間':'立即發佈';};
    mode.addEventListener('change',()=>{pending=null;updateMode();});
    form.addEventListener('input',()=>{pending=null;});
    reset.addEventListener('click',()=>{editing=null;pending=null;reset.classList.add('hidden');mode.disabled=false;mode.value='immediate';date.value='';price.value=String(service.priceAmount);message.textContent='';updateMode();});
    const setBusy=value=>{busy=value;dialog.setAttribute('aria-busy',String(value));for(const el of form.querySelectorAll('input,select,button'))el.disabled=value;mode.disabled=value||Boolean(editing);};
    async function loadHistory(){
      const data=await request('admin.booking.price.catalog',{serviceId:service.serviceId});
      if(!overlay.isConnected)return;history.replaceChildren();
      const rows=Array.isArray(data.publications)?data.publications:[];
      if(!rows.length){history.textContent='尚無價格發佈紀錄。';return;}
      for(const row of rows){
        const line=document.createElement('div');line.className='booking-price-history-row';
        const text=document.createElement('p');text.textContent=`${money(row.priceAmount)} · ${time(row.publishAt)} · ${{scheduled:'待發佈',published:'已發佈',cancelled:'已取消'}[row.status]||row.status}`;line.append(text);
        if(row.status==='scheduled'){
          const actions=document.createElement('div');actions.className='booking-price-history-actions';
          const edit=document.createElement('button');edit.type='button';edit.className='button button-outline';edit.textContent='改期';edit.addEventListener('click',()=>{if(busy)return;editing=row;pending=null;price.value=String(row.priceAmount);date.value=local(row.publishAt);mode.value='scheduled';mode.disabled=true;reset.classList.remove('hidden');message.textContent='正在修改此筆排程；其他價格不受影響。';updateMode();price.focus();});
          const cancel=document.createElement('button');cancel.type='button';cancel.className='button button-danger';cancel.textContent='取消排程';let cancelId=null;
          cancel.addEventListener('click',async()=>{
            if(busy||!window.confirm(`取消 ${time(row.publishAt)} 的 ${money(row.priceAmount)} 價格排程？`))return;
            cancelId ||= crypto.randomUUID();setBusy(true);message.textContent='處理中…';
            try{await request('admin.booking.price.cancel',{publicationId:row.id,expectedUpdatedAt:row.updatedAt,requestId:cancelId});await onSaved();await loadHistory();message.textContent='排程已取消。';}
            catch(error){message.textContent=error?.message||'取消失敗，請更新紀錄後再試。';}
            finally{setBusy(false);}
          });actions.append(edit,cancel);line.append(actions);
        }
        history.append(line);
      }
    }
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(busy)return;message.textContent='';
      const amount=Number(price.value);
      if(!price.value||!Number.isSafeInteger(amount)||amount<0||amount>10000000){message.textContent='價格必須是 0–10,000,000 元的整數。';return;}
      const at=mode.value==='scheduled'?`${date.value}:00+08:00`:null;
      if(at&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(at)||!Number.isFinite(Date.parse(at))||Date.parse(at)<=Date.now())){message.textContent='請選擇有效的未來台北時間。';return;}
      const body={serviceId:service.serviceId,priceAmount:amount,mode:mode.value,publishAt:at,expectedPriceVersion:service.priceVersion,...(editing?{publicationId:editing.id,expectedUpdatedAt:editing.updatedAt}:{})};
      pending ||= crypto.randomUUID();body.requestId=pending;setBusy(true);message.textContent='儲存中…';
      try{await request(editing?'admin.booking.price.reschedule':'admin.booking.price.publish',body);await onSaved();setBusy(false);close();}
      catch(error){message.textContent=error?.message||'價格尚未確認發佈，請更新紀錄後再試。';setBusy(false);}
    });
    updateMode();price.focus();
    try{await loadHistory();}catch(error){history.textContent=error?.message||'無法載入價格紀錄，請關閉後重試。';}
  }
  window.BookingPriceEditor=Object.freeze({open});
})();
