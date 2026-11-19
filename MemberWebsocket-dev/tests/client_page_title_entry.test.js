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
  const node = id => fields[id] ||= { hidden:true,disabled:true,value:'',textContent:'',placeholder:'',dataset:{},attrs:{},
    classList:{add(){},remove(){},toggle(){}},setAttribute(name,value){this.attrs[name]=String(value);},
    getAttribute(name){return this.attrs[name]??null;},click(){this.clicked=true;},
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

test('AC-010: regular admin has a dedicated title tab, preview, save and no redirection',()=>{
  const html=read('admin/index.html'),js=read('admin/app.js');
  assert.match(html,/id="clientPageTitleTab"[^>]*role="tab"[^>]*aria-controls="clientPageTitleShortcut"[^>]*hidden disabled/);
  assert.match(html,/id="clientPageTitleShortcut"[^>]*role="tabpanel"[^>]*aria-labelledby="clientPageTitleTab"[^>]*hidden/);
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
  assert.equal(f.panel.hidden,true,'title editor must stay hidden outside its tab');
  assert.equal(f.fields.clientPageTitleTab.hidden,false);
  assert.equal(f.fields.clientPageTitleTab.disabled,false);
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
  assert.equal(f.fields.clientPageTitleTab.hidden,false);
  f.client.clear();assert.equal(f.panel.hidden,true);
  assert.equal(f.fields.clientPageTitleTab.hidden,true);
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

test('AC-016: dedicated title tab switches its own panel without loading unrelated data', () => {
  const script=read('admin/app.js');
  const start=script.indexOf('  function switchPanel(panel) {');
  const end=script.indexOf('  function switchCardWorkspace(',start);
  assert.ok(start>=0 && end>start,'surface controller must be testable');
  const ids=['members','cards','events','calendar'];
  const fields={};
  function element(id) {
    return fields[id] ||= {
      hidden:false,disabled:false,attrs:{},
      classList:{last:null,toggle(name,value){this.last={name,value};}},
      setAttribute(name,value){this.attrs[name]=String(value);}
    };
  }
  const els={clientPageTitleTab:element('clientPageTitleTab'),clientPageTitleShortcut:element('clientPageTitleShortcut')};
  for(const id of ids){els[id+'Tab']=element(id+'Tab');els[id+'Panel']=element(id+'Panel');}
  const state={activePanel:'members',loadedPanels:Object.fromEntries(ids.map(id=>[id,true]))};
  let loads=0;
  const context={state,els,ensureAdminPanelData(){loads++;return Promise.resolve();},setSyncStatus(){}};
  vm.runInNewContext(script.slice(start,end)+'\nthis.choose = switchPanel;',context);
  context.choose('clientPageTitle');
  assert.equal(els.clientPageTitleShortcut.hidden,false);
  assert.equal(els.clientPageTitleTab.attrs['aria-selected'],'true');
  for(const id of ids)assert.equal(els[id+'Panel'].classList.last.value,true);
  assert.equal(loads,0,'reusing the title loader avoids extra booking/member requests');
  context.choose('cards');
  assert.equal(els.clientPageTitleShortcut.hidden,true);
  assert.equal(els.clientPageTitleTab.attrs['aria-selected'],'false');
  assert.equal(els.cardsPanel.classList.last.value,false);
  els.clientPageTitleTab.disabled=true;
  context.choose('clientPageTitle');
  assert.equal(state.activePanel,'cards','disabled title tab cannot open the editor');
});

test('AC-017: mobile admin tabs use a single native sideways-swiping row with theme parity', () => {
  const css=read('admin/ui-polish-responsive.css');
  const mobile=css.slice(css.indexOf('/* Mobile surface navigation'));
  assert.match(mobile, /@media \(max-width: 760px\)/);
  assert.match(mobile, /html\[data-theme\] #adminView > \.surface-nav/);
  assert.match(mobile, /display:\s*flex/);
  assert.match(mobile, /flex-wrap:\s*nowrap/);
  assert.match(mobile, /overflow-x:\s*auto/);
  assert.match(mobile, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(mobile, /\.surface-tab[\s\S]*?white-space:\s*nowrap/);
  assert.doesNotMatch(mobile, /setInterval|setTimeout/);
});
