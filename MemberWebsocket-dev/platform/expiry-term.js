// Usage period calculator. UTC timestamps preserve exact access expiry semantics.
(function(root){
  'use strict';
  const DAY=86400000,MAX=Date.parse('9999-12-31T23:59:59.000Z');
  function termExpiry(startedAt,days){
    const start=Date.parse(startedAt||''),end=start+days*DAY;
    if(!Number.isFinite(start)||!Number.isSafeInteger(days)||days<1||days>36500||!Number.isFinite(end)||end>MAX)throw new RangeError('INVALID_TERM');
    return new Date(end).toISOString();
  }
  function termDays(startedAt,expiresAt){
    const start=Date.parse(startedAt||''),end=Date.parse(expiresAt||'');
    const days=(end-start)/DAY;
    return Number.isSafeInteger(days)&&days>=1&&days<=36500?days:null;
  }
  function remainingDays(expiresAt,now=Date.now()){
    if(expiresAt===null||expiresAt===undefined||expiresAt==='')return null;
    const end=Date.parse(expiresAt);
    if(!Number.isFinite(end)||!Number.isFinite(now))return null;
    return Math.max(0,Math.ceil((end-now)/DAY));
  }
  function taipeiDateTime(value){
    const date=new Date(value);
    if(!Number.isFinite(date.getTime()))return '日期未提供';
    return new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
  }
  const api=Object.freeze({termExpiry,termDays,remainingDays,taipeiDateTime});
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PlatformExpiryTerm=api;
})(typeof window!=='undefined'?window:globalThis);
