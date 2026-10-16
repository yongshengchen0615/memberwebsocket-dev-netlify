// One formatter shared by the management clipboard and LINE delivery.
(function (root) {
  'use strict';
  function format(b) {
    const names = ['第一','第二','第三','第四','第五','第六','第七','第八','第九','第十'];
    const date = String(b.bookingDate || '—');
    const startDate = String(b.startAt || '').slice(0,10) || date;
    const endDate = String(b.endAt || '').slice(0,10) || date;
    const phone = String(b.phone || '—').replace(/[\s()－—-]/g,'') || '—';
    const participants = Array.isArray(b.participants) ? b.participants : [];
    const lines = [`營業日 ${date}｜${String(b.startTime || '—').slice(0,5)}–${String(b.endTime || '—').slice(0,5)}${endDate > startDate ? '（隔日）' : ''}`,
      String(b.name || '未取得預約人資料'),`電話：${phone}`,`預約人數：${Math.max(1,Number(b.partySize || participants.length || 1))} 位`,''];
    participants.forEach((p,i) => {
      const items = (Array.isArray(p.items) ? p.items : []).map(x => {
        const title = String(x.serviceTitle || '預約項目').trim();
        const quantity = Math.max(1,Number(x.quantity || 1));
        return quantity > 1 ? `${title} × ${quantity}` : title;
      }).join('、') || '—';
      lines.push(`${names[i] || `第 ${i+1} `}位預約`,`預約項目：${items}`,`預約技師：${String(p.technicianName || '現場安排').replace(/（主要技師）/g,'').trim() || '現場安排'}`);
      if(i < participants.length-1) lines.push('');
    });
    return lines.join('\n');
  }
  root.BookingCopyText = Object.freeze({format});
})(globalThis);
