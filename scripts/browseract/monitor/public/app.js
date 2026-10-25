const API='/.netlify/functions/browseract-monitor';
const $=id=>document.getElementById(id);
let credential='',taskId='',liveUrl='',inFlight=false,paused=false;
function say(s,fail=false){$('feedback').textContent=s;$('feedback').className=fail?'fail':'';}
async function call(action,{method='GET',body,id}={}){
 const params=new URLSearchParams({action});if(id)params.set('id',id);
 const res=await fetch(API+'?'+params,{method,cache:'no-store',headers:{Authorization:'Bearer '+credential,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await res.json();
 if(!res.ok){
  const messages={UNAUTHORIZED:'存取金鑰錯誤',ACCESS_NOT_CONFIGURED:'尚未設定管理金鑰',BROWSERACT_NOT_CONFIGURED:'請設定 BrowserAct API Key 與 Bot ID',HUMAN_HANDOFF_NOT_CONFIGURED:'尚未設定 Human Interaction 節點',TASK_NOT_PAUSED:'任務尚未到人工接管點',BROWSERACT_UNAVAILABLE:'BrowserAct 無法回應'};
  const e=new Error(messages[data.error]||('HTTP '+res.status+' / '+data.error));e.status=res.status;throw e;
 }return data;
}
function logout(){
 credential='';taskId='';liveUrl='';$('access-token').value='';
 $('app').hidden=true;$('login-panel').hidden=false;$('live').hidden=true;$('live').removeAttribute('src');$('global-status').textContent='需授權';
}
$('login-form').addEventListener('submit',async e=>{
 e.preventDefault();credential=$('access-token').value.trim();
 try{
  const cfg=await call('config');
  $('login-panel').hidden=true;$('app').hidden=false;$('access-token').value='';
  $('global-status').textContent=cfg.configured?'已授權 · Bot 已設定':'已授權 · 待設定 Bot';
  $('base-url').value=cfg.baseUrl;$('start').disabled=!cfg.configured;$('human-mode').disabled=!cfg.handoffEnabled;
  $('handoff-hint').textContent=cfg.handoffEnabled?'已啟用人工交接，請確認 Bot 的 Human Interaction 節點。':'接管尚未啟用：先設定 BrowserAct Human Interaction 節點和 Netlify 開關。';
  say(cfg.configured?'可以啟動 BrowserAct 真實瀏覽器。':'請先設定 BrowserAct API Key 與 Workflow ID。');
 }catch(err){credential='';$('login-hint').textContent=err.message;}
});
$('logout').addEventListener('click',logout);
$('start-form').addEventListener('submit',async e=>{
 e.preventDefault();$('start').disabled=true;
 try{
  const handoffMode=document.querySelector('input[name="handoff-mode"]:checked').value;
  const task=await call('start',{method:'POST',body:{scenarioId:$('scenario-id').value.trim(),baseUrl:$('base-url').value,handoffMode}});
  attach(task.id);
 }catch(err){say('啟動失敗：'+err.message,true);}finally{$('start').disabled=false;}
});
$('attach-form').addEventListener('submit',e=>{
 e.preventDefault();const id=$('attach-id').value.trim();
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return say('Task ID 格式錯誤',true);attach(id);
});
function attach(id){
 taskId=id;liveUrl='';paused=false;$('task-id').textContent=id;
 $('live').removeAttribute('src');$('live').hidden=true;$('waiting').hidden=false;
 $('open-live').disabled=true;$('resume').disabled=true;$('stop').disabled=true;
 history.replaceState({},'','#task='+encodeURIComponent(id));poll();
}
function image(url){
 const preview=$('preview');preview.hidden=!url;$('no-preview').hidden=!!url;
 if(url)preview.src=url;else preview.removeAttribute('src');
}
function render(task){
 $('task-id').textContent=task.id;$('task-status').textContent=task.status;$('verdict').textContent=String(task.verdict).toUpperCase();
 $('verdict').className=task.verdict==='pass'?'pass':task.verdict==='fail'?'fail':'pending';
 $('step-count').textContent=task.steps.length;
 $('stop').disabled=!['created','running','pausing','paused'].includes(task.status);
 paused=task.status==='paused';$('resume').disabled=!paused;
 if(task.liveUrl&&task.liveUrl!==liveUrl){
  liveUrl=task.liveUrl;$('live').src=liveUrl;$('live').hidden=false;$('waiting').hidden=true;
 }
 $('open-live').disabled=!liveUrl;
 $('control-note').textContent=paused?'Bot 已暫停：你可在 Human Interaction 畫面操作後按「交還自動化」。':
  task.status==='running'?'自動測試中：可觀看，但不可任意中斷接管。':'任務狀態：'+task.status;
 if(paused&&!liveUrl)$('control-note').textContent+=' 若沒有可控制的畫面，請改用 BrowserAct Dashboard 的 Task Control。';
 const steps=$('step-list');steps.replaceChildren();
 task.steps.forEach(step=>{
  const li=document.createElement('li'),button=document.createElement('button');
  button.type='button';button.textContent=step.index+'. ['+step.status+'] '+(step.goal||'執行中');
  button.disabled=!step.screenshot;button.addEventListener('click',()=>image(step.screenshot));li.append(button);
  if(step.evaluation){const small=document.createElement('small');small.textContent=step.evaluation;li.append(small);}
  steps.append(li);
 });
 const latest=[...task.steps].reverse().find(s=>s.screenshot);
 if(latest)image(latest.screenshot);
 const checks=$('assertion-list');checks.replaceChildren();
 (task.checks||[]).forEach(c=>{const li=document.createElement('li');li.textContent=(c.passed?'PASS':'FAIL')+' · '+c.name;li.className=c.passed?'pass':'fail';checks.append(li);});
 say(task.reason||'狀態已更新');$('updated').textContent='更新於 '+new Date().toLocaleTimeString('zh-TW');
}
async function poll(){
 if(inFlight||!taskId||!credential)return;inFlight=true;
 try{render(await call('task',{id:taskId}));}catch(e){if(e.status===401)logout();else say('讀取失敗：'+e.message,true);}finally{inFlight=false;}
}
$('open-live').addEventListener('click',()=>{if(liveUrl)window.open(liveUrl,'_blank','noopener,noreferrer');});
$('resume').addEventListener('click',async()=>{
 if(!taskId||!paused||!confirm('已完成人工操作，確定交還給 BrowserAct？'))return;
 try{await call('resume',{method:'POST',id:taskId});say('已要求 BrowserAct 恢復自動化');await poll();}catch(e){say(e.message,true);}
});
$('stop').addEventListener('click',async()=>{
 if(!taskId||!confirm('停止是永久性的，無法恢復。確定停止？'))return;
 try{await call('stop',{method:'POST',id:taskId});await poll();}catch(e){say(e.message,true);}
});
setInterval(poll,3000);
