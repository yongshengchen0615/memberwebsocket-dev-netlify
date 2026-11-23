(() => {
  'use strict';

  // A fresh page entry must start with its OWN LIFF application, not a cached
  // login belonging to another tab/channel on the same browser origin.
  // Call only AFTER liff.init({ liffId }) resolves; LINE Login itself and all
  // role/tenant authorization remain the responsibility of LINE and the server.
  const PER_TAB_WINDOW_MS = 180_000;
  const LIFF_ID = /^\d{5,30}-[A-Za-z0-9_-]+$/;
  const SCOPE = /^[a-z][a-z0-9-]{0,40}$/;
  const BUSINESS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const PRIVATE_QUERY = /^(?:liff\.|code$|state$|access_token$|id_token$|line_initial$|redirect_uri$|.*(?:token|secret|jwt|api_key|apikey|session|password).*)/i;
  const CALLBACK_QUERY = ['member_system_reauth','booking_system_reauth','frontdesk_line_reauth'];

  function enter({liffId,scope,business=''}={}) {
    const id=String(liffId||'').trim(),role=String(scope||'').trim();
    if(!LIFF_ID.test(id)||!SCOPE.test(role))return false;
    if(!window.liff||typeof window.liff.isInClient!=='function'||typeof window.liff.isLoggedIn!=='function')return false;
    let current,inside,loggedIn;
    try {
      current=new URL(window.location.href);
      inside=window.liff.isInClient();
      loggedIn=window.liff.isLoggedIn();
    }catch{return false;}
    // The LINE browser normally signs in during liff.init(). If another LIFF
    // app's Channel is still cached, enter THIS app instead of showing a stale
    // credential warning. Decoded claims are only an early mismatch hint.
    let wrongInClientChannel=false;
    if(inside&&loggedIn){
      try {
        const aud=window.liff.getDecodedIDToken?.()?.aud;
        wrongInClientChannel=typeof aud==='string'&&aud!==id.split('-')[0];
      }catch{}
    }
    // Local HTTP test fixtures are not registered HTTPS LIFF endpoints.
    if(current.protocol!=='https:'||!loggedIn||(inside&&!wrongInClientChannel))return false;
    // LINE's primary and secondary redirects carry provider parameters that
    // must remain untouched until the SDK has finished initialization.
    if(CALLBACK_QUERY.some(key=>current.searchParams.has(key))
      ||current.searchParams.has('liff.state')||current.searchParams.has('access_token')
      ||current.searchParams.has('line_initial')
      ||(current.searchParams.has('code')&&current.searchParams.has('state')))return false;

    const tenant=String(business||current.searchParams.get('business')||'');
    if(tenant&&!BUSINESS.test(tenant))return false;
    const key='line-initial-entry-v1:'+role+':'+id+':'+current.pathname+':'+tenant;
    let storedAt=0;
    try {
      storedAt=Number(window.sessionStorage.getItem(key)||0);
      const elapsed=Date.now()-storedAt;
      if(storedAt>0&&Number.isFinite(elapsed)&&elapsed>=0&&elapsed<PER_TAB_WINDOW_MS)return false;
    }catch{return false;}

    const entry=new URL('https://liff.line.me/'+id);
    for(const [key,value] of current.searchParams){
      if(PRIVATE_QUERY.test(key))continue;
      if(key==='business'&&tenant)entry.searchParams.set('business',tenant);
      else entry.searchParams.append(key,value);
    }
    if(tenant&&!entry.searchParams.has('business'))entry.searchParams.set('business',tenant);
    entry.searchParams.set('line_initial','1');
    if(current.hash)entry.hash=current.hash;
    try{
      window.sessionStorage.setItem(key,String(Date.now()));
      window.location.replace(entry.href);
      return true;
    }catch{
      try{window.sessionStorage.removeItem(key);}catch{}
      return false;
    }
  }
  window.LineInitialEntry=Object.freeze({enter});
})();
