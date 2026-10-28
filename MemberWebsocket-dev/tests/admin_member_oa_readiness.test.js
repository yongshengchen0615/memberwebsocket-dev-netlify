const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const admin=fs.readFileSync(path.join(root,'admin/business-line-settings.js'),'utf8');
const backend=fs.readFileSync(path.join(root,'supabase/functions/_shared/platform-handler.mjs'),'utf8');
const entry=fs.readFileSync(path.join(root,'supabase/functions/platform-api/index.ts'),'utf8');
const start=admin.indexOf('  function renderMemberReadiness(view) {');
const end=admin.indexOf('  async function checkMemberReadiness(view) {',start);
assert.ok(start>=0 && end>start,'existing merchant LINE settings must implement an observable preflight');

function render({login='2010787602',liff='2010787602-member',serverVerified=false,checkedVersion=7,version=7,pending=false,error=''}={}){
 const list={children:[],replaceChildren(){this.children=[];},append(node){this.children.push(node);}};
 const block={summary:{},list,status:{},reload:{},checkedVersion,verified:serverVerified,pending,error};
 const tenant={version,line:{memberChannelId:login},moduleLine:{membership:{line:{memberLiffId:liff}}}};
 const node=(tag,text)=>({tag,textContent:text||'',dataset:{}});
 const context={tenant,node,saving:false,pendingOperation:()=>false};
 vm.runInNewContext(admin.slice(start,end)+'\nthis.renderMemberReadiness=renderMemberReadiness;',context);
 context.renderMemberReadiness({memberReadiness:block});
 return {heading:block.summary.textContent,messages:list.children.map(x=>x.textContent),status:block.status.textContent,disabled:block.reload.disabled};
}

test('AC-001: merchant UI names each mandatory condition, with unverified OA blocked',()=>{
 const value=render();
 assert.match(value.heading,/尚未可驗證/);
 assert.match(value.messages.join('\n'),/已確認：會員 LINE Login Channel ID/);
 assert.match(value.messages.join('\n'),/已確認：會員卡 LIFF ID/);
 assert.match(value.messages.join('\n'),/待處理：會員官方帳號可信綁定/);
 assert.match(value.status,/首次註冊會被後端拒絕/);
});
test('AC-002: missing or mismatched member LIFF remains not ready even with stale/true server state',()=>{
 for(const args of [{login:'',liff:'2010787602-member',serverVerified:true},{liff:'111111111-member',serverVerified:true},{serverVerified:true,checkedVersion:6}]){
  const value=render(args);
  assert.match(value.heading,/尚未可驗證/);
  assert.ok(value.messages.some(x=>x.startsWith('待處理：')));
 }
});
test('AC-003: current server-confirmed link displays verified, but still requires real LINE test',()=>{
 const value=render({serverVerified:true});
 assert.match(value.heading,/伺服器綁定已確認/);
 assert.equal(value.messages.filter(x=>x.startsWith('待處理：')).length,0);
 assert.match(value.status,/真實 LINE/);
});
test('AC-004: server errors never masquerade as readiness; no secret is rendered',()=>{
 const value=render({error:'連線失敗'});
 assert.match(value.status,/不得視為已開通/);
 assert.doesNotMatch(value.messages.join('\n')+value.status,/channelAccessToken|channelSecret|MEMBER_OA_VERIFIED_LINKS_JSON/);
});
test('AC-005: preflight is authenticated, read-only, tenant-scoped and uses activation binding',()=>{
 assert.match(backend,/memberOaGuidance\(/);
 assert.match(backend,/body\.action === 'platform\.member-oa\.readiness'/);
 assert.match(backend,/workspace\.application\?\.status !== 'approved'/);
 assert.match(backend,/current\.features\?\.membership !== true/);
 assert.match(backend,/verifiedBindingsJson:verifiedMemberOaBindingsJson/);
 assert.match(entry,/verifiedMemberOaBindingsJson:env\('MEMBER_OA_VERIFIED_LINKS_JSON'\)/);
 assert.doesNotMatch(backend,/configured:body\./);
});
