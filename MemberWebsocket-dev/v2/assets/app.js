import {FEATURES,loadConfig,callApi,isEnabled} from './client.js';
const $=id=>document.getElementById(id);
const page=document.body.dataset.page;
const icons={membership:'◇',points:'✦',events:'▣',calendar:'▦',integrations:'⌘',booking:'▤',testing:'◈',usage:'◉'};
let config,identityToken,workspace,selectedFeature;
function show(id,visible){$(id)?.classList.toggle('hidden',!visible)}
function announce(message,error=false){const el=$('notice');el.textContent=message;el.classList.toggle('error',error)}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node}
function button(label,action,disabled=false){const b=el('button','primary',label);b.type='button';b.disabled=disabled;b.addEventListener('click',async()=>{b.disabled=true;try{await action()}catch(err){announce(err.message,true)}finally{b.disabled=false}});return b}
async function api(action,data){return callApi(config,identityToken,action,data)}
function statusText(status){return ({pending:'等待平台審核',approved:'審核通過，等待環境佈建',rejected:'申請未通過',active:'環境已開通',pending_provisioning:'獨立環境佈建中',suspended:'商家已停權'})[status]||'尚未申請'}
function tenantFor(app){return workspace.tenant&&workspace.tenant.id===app?.tenantId?workspace.tenant:null}
function configFor(feature){return workspace?.tenant?.line?.[feature]||{}}
function renderAdmin(){
  const app=workspace.application,tenant=tenantFor(app);
  show('workspace',true);
  $('businessName').textContent=app?.businessName||'尚未申請';
  $('businessStatus').textContent=app?(statusText(app.status)+' · '+(tenant?statusText(tenant.status):'尚未建立商家環境')):'請填寫申請資料';
  $('statusChip').textContent=statusText(app?.status||'pending');
  show('applicationForm',!app||app.status==='pending'||app.status==='rejected');
  if(app){$('applyName').value=app.businessName||'';$('applySlug').value=app.slug||''}
  const grid=$('featureGrid');grid.replaceChildren();
  Object.entries(FEATURES).forEach(([key,label])=>{
    const enabled=Boolean(tenant&&isEnabled(tenant.features,key)),card=el('article','feature-card');
    card.append(el('span','icon',icons[key]),el('h3','',label),
      el('p','',!tenant?'請先取得平台審核':enabled?'已獲授權 · 可設定 LINE':'尚未由總管理員開通'));
    const b=el('button','',enabled?'設定 LINE':'未開通');b.type='button';b.disabled=!enabled||tenant.status==='suspended';
    b.addEventListener('click',()=>openLine(key));card.append(b);grid.append(card);
  });
  show('lineForm',false);
}
function openLine(feature){
  if(!isEnabled(workspace.tenant?.features,feature))return;
  selectedFeature=feature;$('lineTitle').textContent=FEATURES[feature]+' · LINE 設定';
  $('lineFeature').value=feature;
  const saved=configFor(feature);
  $('lineChannel').value=saved.loginChannelId||'';
  $('lineLiff').value=saved.liffId||'';
  $('lineMessaging').value=saved.messagingChannelId||'';
  $('lineToken').value='';$('lineSecret').value='';
  show('lineForm',true);$('lineForm').scrollIntoView({behavior:'smooth',block:'start'});
}
function featureFlags(tenant){
  const wrapper=el('div','flag-list');
  Object.entries(FEATURES).forEach(([key,label])=>{
    const labelEl=el('label');const input=el('input');
    input.type='checkbox';input.dataset.feature=key;input.checked=tenant?.features?.[key]===true;
    labelEl.append(input,el('span','',label));wrapper.append(labelEl);
  });
  return wrapper;
}
function renderPlatform(){
  if(workspace.scope!=='platform')throw new Error('尚未取得由資料庫手動授予的總管理員權限');
  show('workspace',true);
  const list=$('applications'),tenants=$('tenants');list.replaceChildren();tenants.replaceChildren();
  const apps=workspace.applications||[];
  $('reviewCount').textContent=apps.filter(a=>a.status==='pending').length+' 筆待審核';
  if(!apps.length)list.append(el('p','hint','目前沒有管理員申請。'));
  apps.forEach(app=>{
    const card=el('article','application-card');const hd=el('header');
    const info=el('div');info.append(el('h3','',app.businessName),el('p','',app.slug+' · '+statusText(app.status)));
    hd.append(info,el('span','status',statusText(app.status)));card.append(hd);
    if(app.status==='pending'){
      const flags=featureFlags(null);card.append(flags);
      card.append(button('核准功能並建立待佈建商家',async()=>{
        const selected=Object.fromEntries([...flags.querySelectorAll('input')].map(n=>[n.dataset.feature,n.checked]));
        await api('application.approve',{applicationId:app.id,features:selected,requestId:crypto.randomUUID()});
        announce('已核准功能；獨立 Supabase 專案完成隔離前不會啟用。');await reload();
      }));
    } list.append(card);
  });
  (workspace.tenants||[]).forEach(tenant=>{
    const card=el('article','application-card');card.append(el('h3','',tenant.name),el('p','',tenant.slug+' · '+statusText(tenant.status)));
    const flags=featureFlags(tenant);card.append(flags);
    card.append(button('儲存功能權限',async()=>{
      const selected=Object.fromEntries([...flags.querySelectorAll('input')].map(n=>[n.dataset.feature,n.checked]));
      await api('feature.update',{tenantId:tenant.id,expectedVersion:tenant.version,features:selected,requestId:crypto.randomUUID()});
      announce('功能權限已更新，商家 LINE 憑證不受影響。');await reload();
    }));
    tenants.append(card);
  });
}
async function reload(){
  workspace=await api(page==='admin'?'application.ensure':'bootstrap');
  page==='admin'?renderAdmin():renderPlatform();
  announce(page==='admin'?'登入成功，已同步申請與功能狀態。':'身分已驗證；僅能審核及修改功能權限。');
}
async function signIn(){
  if(!config){announce('V2 獨立平台尚未設定，禁止連回舊系統。',true);return}
  if(!window.liff)throw new Error('LINE LIFF SDK 未載入');
  if(!window.liff.isLoggedIn()){window.liff.login();return}
  identityToken=window.liff.getIDToken();
  if(!identityToken)throw new Error('無法取得 LINE 身分憑證');
  await reload();show('auth',false);
}
async function startup(){
  try{
    config=await loadConfig();announce('V2 環境已配置。請使用 LINE 驗證身分。');
    if(!window.liff)throw new Error('LINE LIFF SDK 未載入，請檢查網路或 LINE 環境');
    await window.liff.init({liffId:config.platformLiffId});
    $('signIn').disabled=false;$('signIn').addEventListener('click',()=>signIn().catch(e=>announce(e.message,true)));
  }catch(err){announce(err.message,true);$('signIn').disabled=true}
}
if(page==='admin'){
  $('applicationForm').addEventListener('submit',async e=>{
    e.preventDefault();const b=e.submitter;b.disabled=true;
    try{workspace=await api('application.apply',{businessName:$('applyName').value.trim(),slug:$('applySlug').value.trim(),requestId:crypto.randomUUID()});renderAdmin();announce('申請已送出，等待總管理員核准。')}
    catch(err){announce(err.message,true)}finally{b.disabled=false}
  });
  $('lineForm').addEventListener('submit',async e=>{
    e.preventDefault();const b=e.submitter;b.disabled=true;
    const secret=$('lineSecret').value.trim(),token=$('lineToken').value.trim();
    try{
      if(Boolean(secret)!==Boolean(token))throw new Error('Channel token 與 secret 必須同時輸入');
      const payload={feature:selectedFeature,expectedVersion:workspace.tenant.version,requestId:crypto.randomUUID(),
        config:{loginChannelId:$('lineChannel').value.trim(),liffId:$('lineLiff').value.trim(),messagingChannelId:$('lineMessaging').value.trim()}};
      if(secret)payload.credentials={channelAccessToken:token,channelSecret:secret};
      await api('line.save',payload);$('lineSecret').value='';$('lineToken').value='';
      await reload();announce('LINE 設定已加密保存，密鑰不會回傳瀏覽器。');
    }catch(err){announce(err.message,true)}finally{b.disabled=false}
  });
  $('closeLine').addEventListener('click',()=>show('lineForm',false));
}
if(page==='admin'||page==='platform')startup();
