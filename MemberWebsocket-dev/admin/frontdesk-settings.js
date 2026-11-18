(() => {
 'use strict';
 const mounted=new WeakSet();
 const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
 function mount({root,request,business}){
  if(mounted.has(root))return;mounted.add(root);
  const details=node('details');details.className='frontdesk-settings';details.dataset.frontdeskSettings='true';
  details.append(node('summary','櫃檯官方帳號與人員權限'));
  const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const content=node('div'),reload=node('button','載入櫃檯設定與人員');reload.type='button';details.append(status,reload,content);root.append(details);
  let data=null,busy=false,pending=null;
  const alive=()=>details.isConnected;
  function lock(){for(const control of details.querySelectorAll('input,select,button'))control.disabled=busy||!!pending;const retry=details.querySelector('[data-frontdesk-retry]');if(!busy&&pending&&retry)retry.disabled=false;}
  async function save(action,payload,button){
   if(busy)return;const body=pending?.body||{...payload,requestId:crypto.randomUUID()};
   if(pending&&pending.action!==action)return;
   pending={action,body};busy=true;button.dataset.frontdeskRetry='true';lock();
   try{const result=await request(action,body);if(!alive())return;pending=null;data=result;render();status.textContent='櫃檯設定與權限已儲存。';}
   catch(error){if(!alive())return;if(!error.uncertain)pending=null;else button.textContent='重試相同儲存操作';status.textContent=error.message;}
   finally{busy=false;if(alive())lock();}
  }
  function render(){
   content.replaceChildren();const cfg=data.frontdesk||{};
   content.append(node('p','每位人員先從此商家的櫃檯入口申請，核准後才會收到預約訊息；權限可逐人設定。'));
   const form=node('form');
   for(const [name,label]of [['loginChannelId','櫃檯 Login Channel ID'],['liffId','櫃檯 LIFF ID'],['messagingChannelId','櫃檯 Messaging API Channel ID'],['channelAccessToken','櫃檯 Channel access token（已儲存不回顯）']]){
    const wrap=node('label',label),input=node('input');input.name=name;input.type=name==='channelAccessToken'?'password':'text';input.autocomplete='off';input.value=cfg[name]||'';input.required=name!=='channelAccessToken'||!cfg.liffId;
    if(cfg.liffId&&['loginChannelId','liffId'].includes(name))input.readOnly=true;wrap.append(input);form.append(wrap);
   }
   const enabledWrap=node('label','啟用櫃檯入口與通知'),enabled=node('input');enabled.type='checkbox';enabled.name='enabled';enabled.checked=cfg.enabled!==false;enabledWrap.append(enabled);form.append(enabledWrap);
   const saveButton=node('button','驗證並儲存櫃檯設定');saveButton.type='submit';saveButton.className='frontdesk-primary';form.append(saveButton);
   form.onsubmit=e=>{e.preventDefault();if(pending){if(pending.action==='platform.frontdesk.settings.save')void save(pending.action,pending.body,saveButton);return;}if(!form.reportValidity())return;const values=Object.fromEntries(new FormData(form));void save('platform.frontdesk.settings.save',{expectedVersion:data.version,settings:{loginChannelId:values.loginChannelId.trim(),liffId:values.liffId.trim(),messagingChannelId:values.messagingChannelId.trim(),enabled:enabled.checked},channelAccessToken:values.channelAccessToken.trim()},saveButton);};content.append(form);
   content.append(node('small','請在 LINE Developers 將櫃檯 LIFF Endpoint 設為下方網址，並將 Login Channel 與此官方帳號置於同一 Provider、設定官方帳號綁定。'));
   const endpoint=node('p','LIFF Endpoint：'+location.origin+'/frontdesk/?business='+encodeURIComponent(business));content.append(endpoint);
   if(cfg.liffId){const p=node('p'),link=node('a','開啟櫃檯申請／預約入口');link.href='https://liff.line.me/'+cfg.liffId+'?business='+encodeURIComponent(business);link.target='_blank';link.rel='noopener';p.append(link);content.append(p);}
   if(cfg.oaId){const p=node('p'),link=node('a','加入櫃檯官方帳號 '+cfg.oaId);link.href='https://line.me/R/ti/p/'+encodeURIComponent(cfg.oaId);p.append(link);content.append(p);}
   content.append(node('h3','櫃檯人員審核與逐人授權'));
   if(!data.staff?.length)content.append(node('p','目前沒有櫃檯申請。'));
   for(const person of data.staff||[]){const row=node('form');row.className='frontdesk-person';row.append(node('h4',person.displayName),node('p','目前狀態：'+({pending:'待審核',approved:'已核准',rejected:'已拒絕',suspended:'已停用'}[person.status]||person.status)));
    const statusLabel=node('label','審核狀態'),state=node('select');state.name='staffStatus';for(const [v,l]of [['approved','核准'],['rejected','拒絕申請'],['suspended','停用']]){const option=node('option',l);option.value=v;state.append(option);}state.value=person.status==='pending'?'approved':person.status;statusLabel.append(state);
    const modeLabel=node('label','預約權限'),mode=node('select');mode.name='permissionMode';for(const [v,l]of [['notify_only','僅接收預約訊息'],['review','接收通知，並可確認／拒絕預約']]){const option=node('option',l);option.value=v;mode.append(option);}mode.value=person.permissionMode;modeLabel.append(mode);
    const button=node('button','儲存此人員權限');button.type='submit';row.append(statusLabel,modeLabel,button);row.onsubmit=e=>{e.preventDefault();void save('platform.frontdesk.staff.save',{staffId:person.id,expectedVersion:person.version,status:state.value,permissionMode:mode.value},button);};content.append(row);
   }
  }
  async function load(){if(busy||pending)return;busy=true;lock();try{const result=await request('platform.frontdesk.get');if(!alive())return;data=result;render();status.textContent='已載入此商家的櫃檯設定。';}catch(e){if(alive())status.textContent=e.message;}finally{busy=false;if(alive())lock();}}
  reload.onclick=()=>void load();details.addEventListener('toggle',()=>{if(details.open&&!data)void load();});
 }
 window.FrontdeskSettings=Object.freeze({mount});
})();
