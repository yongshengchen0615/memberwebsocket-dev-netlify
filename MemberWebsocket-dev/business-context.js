(() => {
 'use strict';
 const params=new URLSearchParams(window.location.search);
 let slug=params.get('business')||'';
 if(!slug&&params.get('liff.state')){try{slug=new URL(params.get('liff.state'),window.location.origin).searchParams.get('business')||'';}catch{}}
 if(slug&&!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug))throw Error('商家入口格式不正確。');
 const original=window.fetch.bind(window);
 async function configure(config){
  if(!slug)return config;
  const url=new URL(config.supabaseFunctionUrl);url.pathname=url.pathname.replace(/\/api\/?$/,'/platform-api');
  const response=await original(url.href,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey},body:JSON.stringify({action:'platform.business.public',business:slug,...({member:'membership',points:'points',event:'events',calendar:'calendar',booking:'booking'}[location.pathname.split('/')[1]]?{feature:{member:'membership',points:'points',event:'events',calendar:'calendar',booking:'booking'}[location.pathname.split('/')[1]]}:{})}),cache:'no-store'});
  const body=await response.json();if(!response.ok||!body.ok)throw Object.assign(Error(body.error?.message||'無法取得商家設定。'),{code:body.error?.code||'BUSINESS_UNAVAILABLE'});
  config.business=body.data.business;config.brandName=body.data.name;config.grantedFeatures=body.data.features;
  for(const key of ['adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId']){
   if(body.data.line?.[key])config[key]=body.data.line[key];
   else if(key!=='adminLiffId'&&body.data.line?.memberChannelId&&body.data.line.memberChannelId!=='2010787602')config[key]='';
  }
  return config;
 }
 window.BusinessContext=Object.freeze({configure,get slug(){return slug;},set(value){if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value))throw Error('Invalid business');slug=value;}});
 window.fetch=function(input,init){
  if(slug&&init&&typeof init.body==='string'){
   try{
    const u=new URL(typeof input==='string'?input:input.url||input.href,window.location.href);
    if(/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\//.test(u.href)){
     const body=JSON.parse(init.body);
     if(body&&typeof body==='object'&&!Array.isArray(body)&&!/^platform\.(qualification|merchant)\./.test(String(body.action||'')))init={...init,body:JSON.stringify({...body,business:slug})};
    }
   }catch{}
  }
  return original(input,init);
 };
 const retain=()=>{if(!slug)return;for(const a of document.querySelectorAll('a[href]')){
  if(a.dataset?.businessSwitch==='true')continue;
  try{const u=new URL(a.href,window.location.href);if(u.origin===location.origin&&/^\/(?:admin|member|points|event|calendar|booking)\//.test(u.pathname)&&!u.pathname.endsWith('workspace.html')){u.searchParams.set('business',slug);a.href=u.href;}}catch{}
 }};
 document.addEventListener('DOMContentLoaded',retain);
 document.addEventListener('productized-admin-ready',retain);
 if(typeof MutationObserver==='function')new MutationObserver(retain).observe(document.documentElement,{childList:true,subtree:true});
})();
