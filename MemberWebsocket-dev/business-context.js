(() => {
 'use strict';
 const params=new URLSearchParams(window.location.search);
 let slug=params.get('business')||'';
 if(!slug&&params.get('liff.state')){try{slug=new URL(params.get('liff.state'),window.location.origin).searchParams.get('business')||'';}catch{}}
 if(slug&&!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug))throw Error('商家入口格式不正確。');
 const original=window.fetch.bind(window);
 const memberSurface=({member:'membership',points:'points',event:'events',calendar:'calendar',booking:'booking'})[location.pathname.split('/')[1]];
 let grants=null,requestSequence=0,latestPublic=null;
 const configs=new Set();
 const allows=feature=>!slug||!memberSurface||grants?.[feature]===true;
 const allowsBenefit=kind=>allows(({points:'points',event:'events',calendar:'calendar'})[kind]);
 function gate(){
  if(!slug||!memberSurface||!document.querySelectorAll)return;
  const setAllowed=(node,allowed)=>{
   if(node.dataset.memberAllowed!==String(allowed))node.dataset.memberAllowed=String(allowed);
   node.inert=!allowed;
  };
  const mark=(selector,features,any=false)=>document.querySelectorAll(selector).forEach(node=>{
   const allowed=(any?features.some(allows):features.every(allows));
   setAllowed(node,allowed);
  });
  mark('#memberView,#pointsView,#eventView,#calendarView,#bookingView',[memberSurface]);
  mark('[role="dialog"]',[memberSurface]);
  mark('#membershipProgress',['membership']);
  mark('#friendsPanel,#bookingFriendsModal',['membership']);
  mark('#bookingBenefits',['points','events','calendar'],true);
  mark('#bookingAccessibleTickets,#bookingAccessibleTicketsStatus,#bookingAccessibleTicketHeading,#bookingAccessibleTicketHelp,#bookingTicketRedemptionHint,#snapshotTicketFields,.booking-confirm-benefits',['points','events'],true);
  for(const [kind,feature]of Object.entries({points:'points',event:'events',calendar:'calendar'})){
   mark(`[data-benefit-kind="${kind}"],[data-kind="${kind}"],[data-snapshot-kind="${kind}"]`,[feature]);
  }
  mark('.service-type-reward,.group-service-reward',['points']);
  for(const node of document.querySelectorAll('[data-member-requires]'))setAllowed(node,node.dataset.memberRequires.split(' ').every(allows));
  for(const node of document.querySelectorAll('[data-member-any]'))setAllowed(node,node.dataset.memberAny.split(' ').some(allows));
  for(const node of document.querySelectorAll('a[href]')){
   try{const u=new URL(node.href,location.href),feature=({member:'membership',points:'points',event:'events',calendar:'calendar',booking:'booking'})[u.pathname.split('/')[1]];
    if(u.origin===location.origin&&feature&&u.searchParams.get('business')===slug){node.dataset.memberAllowed=String(allows(feature));node.inert=!allows(feature);}
   }catch{}
  }
 }
 function applyFeatures(features){
  if(!memberSurface)return;
  const next=Object.fromEntries(['membership','points','events','calendar','booking'].map(key=>[key,features?.[key]===true]));
  const changed=JSON.stringify(next)!==JSON.stringify(grants);grants=next;
  for(const config of configs)config.grantedFeatures={...next};
  if(memberSurface&&slug&&document.createElement&&!document.getElementById('memberFeatureGateStyle')){
   const style=document.createElement('link');style.id='memberFeatureGateStyle';style.rel='stylesheet';
   style.href=new URL('../business-context.css?v=member-grants-20261107-1',location.href).href;document.head.append(style);
  }
  gate();
  if(changed&&memberSurface&&typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent('business:features-changed',{detail:{features:{...next}}}));
 }
 function updatePageTitle(config){
  const page={member:'會員卡',points:'集點卡',event:'活動票券',calendar:'活動日曆',booking:'預約'}[location.pathname.split('/')[1]];
  if(!page)return;
  const brand=String(config.brandName||'Lumen Club').trim().slice(0,60)||'Lumen Club';
  document.title=brand+'｜'+page;
 }
 async function configure(config,refresh=false){
  if(!slug){updatePageTitle(config);return config;}
  const sequence=++requestSequence,requestedSlug=slug;
  const url=new URL(config.supabaseFunctionUrl);url.pathname=url.pathname.replace(/\/api\/?$/,'/platform-api');
  const controller=refresh?new AbortController():null;
  const timer=controller?window.setTimeout(()=>controller.abort(),15000):null;
  let response,body;
  try{
   response=await original(url.href,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey},body:JSON.stringify({action:'platform.business.public',business:slug,...(!refresh&&memberSurface?{feature:memberSurface}:{})}),cache:'no-store',...(controller?{signal:controller.signal}:{})});
   body=await response.json();
  }finally{if(timer!==null)window.clearTimeout(timer);}
  if(!response.ok||!body.ok)throw Object.assign(Error(body.error?.message||'無法取得商家設定。'),{code:body.error?.code||'BUSINESS_UNAVAILABLE'});
  if(body.data.business!==requestedSlug)throw Error('商家設定不一致。');
  if(requestedSlug!==slug)throw Error('商家入口已變更。');
  if(sequence===requestSequence)latestPublic=body.data;
  const data=sequence===requestSequence?body.data:latestPublic;
  if(!data)throw Error('商家設定仍在更新，請重試。');
  configs.add(config);
  config.business=data.business;config.brandName=data.siteTitle||data.name;config.grantedFeatures=data.features;
  if(!refresh)for(const key of ['adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId']){
   // Grants may be newer than this module-specific response. Its LINE identity
   // must still come from the feature-scoped request, never an unscoped refresh.
   if(body.data.line?.[key])config[key]=body.data.line[key];
   else if(key!=='adminLiffId'&&body.data.line?.memberChannelId&&body.data.line.memberChannelId!=='2010787602')config[key]='';
  }
  updatePageTitle(config);
  applyFeatures(data.features);
  return config;
 }
 window.BusinessContext=Object.freeze({configure,refresh:config=>configure(config,true),allows,allowsBenefit,get slug(){return slug;},set(value){if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value))throw Error('Invalid business');slug=value;grants=null;latestPublic=null;configs.clear();gate();}});
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
 }gate();};
 document.addEventListener('DOMContentLoaded',retain);
 document.addEventListener('productized-admin-ready',retain);
 if(typeof MutationObserver==='function')new MutationObserver(retain).observe(document.documentElement,{childList:true,subtree:true});
})();
