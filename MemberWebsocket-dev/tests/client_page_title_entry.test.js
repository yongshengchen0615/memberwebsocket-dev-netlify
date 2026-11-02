const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const flush = async () => { for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve)); };
function fixture(responder = null) {
  const fields = {};
  const node = id => fields[id] ||= { hidden:true,disabled:true,value:'',textContent:'',placeholder:'',
    listeners:{},addEventListener(name,fn){this.listeners[name]=fn;} };
  const form=node('clientPageTitleForm');
  form.reset=()=>{node('clientPageTitleInput').value='';};
  form.reportValidity=()=>true;
  const input=node('clientPageTitleInput'), save=node('clientPageTitleSave');
  const panel=node('clientPageTitleShortcut');
  const requests=[];
  const fetch=async (url,opts)=>{
    const body=JSON.parse(opts.body);requests.push({url,body});
    const output=responder ? await responder(body,requests.length) : body.action==='platform.application.bootstrap'
      ? {ok:true,data:{application:{status:'approved'},tenant:{slug:body.business,version:2,status:'active',expired:false,name:'原商家',siteTitle:null}}}
      : {ok:true,data:{tenant:{slug:body.business,version:3,status:'active',name:'原商家',siteTitle:body.title||null}}};
    if(output instanceof Error)throw output;
    return {ok:output.ok!==false,status:output.status||200,json:async()=>output};
  };
  const window={};
  const document={getElementById:node};
  const crypto={randomUUID:()=> '10000000-0000-4000-8000-000000000001'};
  vm.runInNewContext(read('admin/client-title-shortcut.js'),{
    window,document,URL,AbortController,setTimeout,clearTimeout,fetch,crypto,
  });
  const client=window.ClientPageTitleShortcut;
  const config=slug=>({productizedAdmin:true,business:slug,supabaseFunctionUrl:'https://db.example.supabase.co/functions/v1/api',supabasePublishableKey:'public-test-key'});
  const submit=async()=>{await form.listeners.submit({preventDefault(){}});await flush();};
  return {client,config,fields,input,save,panel,form,requests,flush,submit};
}

test('AC-010: regular admin has an inline form, preview, save and no redirection',()=>{
  const html=read('admin/index.html'),js=read('admin/app.js');
  assert.match(html,/id="clientPageTitleShortcut"[^>]*hidden/);
  assert.match(html,/id="clientPageTitleForm"/);
  assert.match(html,/id="clientPageTitleInput"[^>]*maxlength="60"/);
  assert.match(html,/id="clientPageTitleSave"[^>]*>儲存網頁抬頭/);
  assert.match(html,/id="clientPageTitlePreview"/);
  assert.doesNotMatch(html,/id="clientPageTitleSettingsLink"/);
  assert.match(js,/view === 'admin'\) window\.ClientPageTitleShortcut\?\.sync\(state\.config, state\.idToken\)/);
  assert.match(js,/else window\.ClientPageTitleShortcut\?\.clear\(\)/);
  assert.match(read('admin/workspace.html'),/id="merchantTitleForm"/);
});

test('AC-011: approved merchant can edit and clear title in the same page without changing name',async()=>{
  const f=fixture();
  f.client.sync(f.config('merchant-a'),'verified-id-token');await f.flush();
  assert.equal(f.panel.hidden,false);
  assert.equal(f.input.disabled,false);
  assert.equal(f.input.value,'');
  assert.equal(f.fields.clientPageTitlePreview.textContent,'原商家｜預約');
  f.input.value='晨光工作室';f.input.listeners.input();
  assert.equal(f.fields.clientPageTitlePreview.textContent,'晨光工作室｜預約');
  await f.submit();
  assert.equal(f.fields.clientPageTitleStatus.textContent.includes('已儲存'),true);
  assert.equal(f.requests[1].body.action,'platform.title.save');
  assert.equal(f.requests[1].body.expectedVersion,2);
  assert.equal(f.requests[1].body.title,'晨光工作室');
  assert.equal(f.requests[1].body.business,'merchant-a');
  assert.equal(f.requests[1].body.idToken,'verified-id-token');
  f.input.value='';f.input.listeners.input();await f.submit();
  assert.equal(f.requests[2].body.expectedVersion,3);
  assert.equal(f.requests[2].body.title,'');
  assert.equal(f.fields.clientPageTitlePreview.textContent,'原商家｜預約');
  assert.equal(f.requests.every(r=>r.url==='https://db.example.supabase.co/functions/v1/platform-api'),true);
});

test('AC-012: unscoped, legacy, malformed slug or missing identity cannot read or save',async()=>{
  const f=fixture();
  for(const [c,t] of [[null,'token'],[{},'token'],[f.config('../root'),'token'],[f.config('merchant-a?x'),'token'],
    [f.config('merchant-a'),''],[{...f.config('merchant-a'),productizedAdmin:false},'token']]){
    f.client.sync(c,t);await f.flush();
    assert.equal(f.panel.hidden,true);
    assert.equal(f.save.disabled,true);
  }
  assert.equal(f.requests.length,0);
  f.client.sync(f.config('merchant-a'),'token');await f.flush();
  assert.equal(f.panel.hidden,false);
  f.client.clear();assert.equal(f.panel.hidden,true);
  assert.equal(f.save.disabled,true);
});

test('AC-013: mismatching merchant, suspended or revoked access fail closed',async()=>{
  for(const mode of ['mismatch','suspended','forbidden']){
    const f=fixture(body => body.action === 'platform.application.bootstrap' ?
      mode==='forbidden'?{ok:false,status:403,error:{message:'已撤權'}}:
      {ok:true,data:{application:{status:'approved'},tenant:{slug:mode==='mismatch'?'merchant-b':body.business,version:2,name:'原商家',status:mode==='suspended'?'suspended':'active'}}}:null);
    f.client.sync(f.config('merchant-a'),'token');await f.flush();
    assert.equal(f.input.disabled,true);
    assert.equal(f.save.disabled,true);
    assert.equal(f.requests.length,1);
  }
});

test('AC-014: network ambiguity replays exact same requestId, never duplicates operation',async()=>{
  let failed=false;
  const f=fixture((body)=>{
    if(body.action==='platform.application.bootstrap')
      return {ok:true,data:{application:{status:'approved'},tenant:{slug:body.business,version:2,name:'原商家',status:'active'}}};
    if(!failed){failed=true;return new Error('network');}
    return {ok:true,data:{tenant:{slug:body.business,version:3,name:'原商家',status:'active',siteTitle:body.title}}};
  });
  f.client.sync(f.config('merchant-a'),'token');await f.flush();
  f.input.value='新名稱';await f.submit();
  assert.match(f.fields.clientPageTitleStatus.textContent,/不確定|未確認/);
  assert.equal(f.save.textContent,'重試相同操作');
  await f.submit();
  assert.deepEqual(f.requests[1].body,f.requests[2].body);
  assert.match(f.fields.clientPageTitleStatus.textContent,/已儲存/);
});

test('AC-015: stale version refuses auto-retry and forbidden write clears editor',async()=>{
  for(const code of [409,403]){
    const f=fixture(body=>body.action==='platform.application.bootstrap'?
      {ok:true,data:{application:{status:'approved'},tenant:{slug:body.business,version:2,name:'原商家',status:'active'}}}
      :{ok:false,status:code,error:{message:'操作已拒絕'}});
    f.client.sync(f.config('merchant-a'),'token');await f.flush();
    f.input.value='測試';await f.submit();
    assert.equal(f.requests.length,2);
    if(code===409){assert.match(f.fields.clientPageTitleStatus.textContent,/重新整理/);assert.equal(f.save.disabled,true);}
    else{assert.equal(f.panel.hidden,true);assert.equal(f.save.disabled,true);}
  }
});
