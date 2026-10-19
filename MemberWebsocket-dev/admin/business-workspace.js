(() => {
 'use strict';
 const panels={membership:'members',points:'cards',events:'events',calendar:'calendar',integrations:'operationsHub',booking:'booking',testing:'testMode',usage:'operationAudit'};
 let latest=null;
 function apply(data){
  latest=data;
  for(const [feature,name]of Object.entries(panels)){
   const tab=document.getElementById(name+'Tab'),panel=document.getElementById(name+'Panel'),allowed=data.features[feature]===true;
   if(tab){tab.hidden=!allowed;tab.disabled=!allowed;tab.dataset.businessAllowed=String(allowed);}
   if(panel){panel.hidden=!allowed;if(!allowed)panel.classList.add('hidden');}
  }
  const usage=document.getElementById('memberUsageTab');if(usage){usage.hidden=!data.features.usage;usage.disabled=!data.features.usage;usage.dataset.businessAllowed=String(!!data.features.usage);}
  if(!document.getElementById('businessWorkspaceStatus')){
   const status=document.createElement('section');status.id='businessWorkspaceStatus';status.className='form-message success';status.setAttribute('role','status');
   const text=document.createElement('span');text.textContent=(data.business?.name||'商家')+'｜審核已通過，已核准功能可立即使用。 ';
   status.append(text);document.querySelector('#adminView')?.prepend(status);
   if(!data.features.membership&&['points','events','calendar','booking'].some(key=>data.features[key])){
    const terms=document.getElementById('memberTermsPanel');
    if(terms){const button=document.createElement('button');button.type='button';button.className='button button-outline';button.textContent='設定會員加入條款';button.onclick=()=>{terms.hidden=false;terms.classList.toggle('hidden');window.dispatchEvent(new CustomEvent('member-workspace-selected',{detail:{workspace:'terms'}}));};status.append(button,terms);}
   }
  }
  window.BusinessLineSettings?.apply(data);
 }
 function select(){
  if(!latest)return;
  apply(latest);
  const requested=new URLSearchParams(location.search).get('feature');
  const chosen=requested&&latest.features[requested]?document.getElementById(panels[requested]+'Tab'):null;
  const current=document.querySelector('.surface-nav [aria-selected="true"]:not([hidden]):not(:disabled)');
  (chosen||current||document.querySelector('.surface-nav button[data-business-allowed="true"]'))?.click();
 }
 document.addEventListener('click',event=>{const target=event.target.closest?.('[data-business-allowed="false"]');if(target){event.preventDefault();event.stopImmediatePropagation();}},true);
 window.addEventListener('member-admin-ready',select);
 // Booking and other extensions may mount after the initial bootstrap.
 // Apply current grants before a late tab or panel becomes available.
 const observer=new MutationObserver(()=>{if(latest)apply(latest);});
 for(const target of [document.getElementById('adminView'),document.querySelector('#adminView .surface-nav')])
  if(target)observer.observe(target,{childList:true});
 window.BusinessWorkspace=Object.freeze({apply});
})();
