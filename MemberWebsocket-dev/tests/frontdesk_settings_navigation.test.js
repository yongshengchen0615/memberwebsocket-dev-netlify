const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const platform=read('platform/app.js');
const admin=read('admin/index.html');
const merchant=read('admin/workspace.html');
const business=read('admin/business-workspace.js');
const line=read('admin/business-line-settings.js');
const frontdesk=read('admin/frontdesk-settings.js');

test('AC-FD-NAV-001: approved merchant has a separate frontdesk URL next to manage-business',()=>{
  assert.match(platform,/manage\.textContent='管理商家'/);
  assert.match(platform,/frontdesk\.textContent='櫃檯設定'/);
  assert.match(platform,/frontdesk\.href='\/admin\/frontdesk-settings\/\?business='\+encodeURIComponent\(application\.slug\)/);
  assert.doesNotMatch(platform,/frontdesk\.href='\/admin\/\?business='.*settings=frontdesk/);
  assert.match(platform,/actions\.append\(manage\)/);
  assert.match(platform,/actions\.append\(frontdesk\)/);
  assert.match(platform,/tenant\?\.features\?\.booking===true && tenant\?\.features\?\.frontdesk===true/);
});

test('AC-FD-NAV-002: frontdesk settings is a standalone document, not a workbench tab',()=>{
  const page=read('admin/frontdesk-settings/index.html');
  assert.match(page,/<html[^>]*data-frontdesk-page/);
  assert.match(page,/<main[^>]*id="frontdeskSettingsPage"/);
  assert.match(page,/id="frontdeskSettingsRoot"[^>]*data-frontdesk-settings-root/);
  assert.match(page,/frontdesk-settings-page\.js/);
  assert.match(page,/<a[^>]*id="frontdeskBackToMerchants"[^>]*data-business-switch="true"/);
  assert.doesNotMatch(page,/id="adminView"|id="merchantWorkspace"|管理工作台|productizedAdmin/);
  for(const html of [admin,merchant]){
    assert.doesNotMatch(html,/id="frontdeskSettingsTab"|id="frontdeskSettingsPanel"|id="merchantFrontdeskSettingsTab"|id="merchantFrontdeskSettingsPanel"/);
    assert.doesNotMatch(html,/data-frontdesk-settings-root/);
  }
  assert.doesNotMatch(business,/selectFrontdeskTab\(/);
  assert.doesNotMatch(line,/FrontdeskSettings\?\.mount\(/);
});

test('AC-FD-NAV-003: separate page validates LINE identity and server-side merchant permissions',()=>{
  const script=read('admin/frontdesk-settings/frontdesk-settings-page.js');
  assert.match(script,/BusinessContext\.configure\(/);
  assert.match(script,/liff\.init\(/);
  assert.match(script,/liff\.getIDToken\(/);
  assert.match(script,/platform\.application\.bootstrap/);
  assert.match(script,/application\?\.status\s*!==\s*'approved'/);
  assert.match(script,/features\?\.booking\s*!==\s*true/);
  assert.match(script,/features\?\.frontdesk\s*!==\s*true/);
  assert.match(script,/FrontdeskSettings\.mount\(/);
  assert.match(script,/FrontdeskSettings\?\.clear\(/);
  assert.match(script,/idToken/);
  assert.doesNotMatch(script,/localStorage\.setItem\([^\n]*[Tt]oken/);
});

test('AC-FD-NAV-004: old deep links redirect to the independent page without opening a tab',()=>{
  assert.match(platform,/settings'\)===\s*'frontdesk'/);
  assert.match(platform,/location\.replace\(/);
  assert.match(platform,/\/admin\/frontdesk-settings\/\?business=/);
  assert.doesNotMatch(business,/get\('settings'\)==='frontdesk'/);
});

test('AC-FD-NAV-005: existing settings and staff permissions use their unchanged API actions',()=>{
  assert.match(frontdesk,/platform\.frontdesk\.settings\.save/);
  assert.match(frontdesk,/platform\.frontdesk\.staff\.save/);
  assert.match(frontdesk,/platform\.frontdesk\.get/);
  assert.match(frontdesk,/mounted\.delete\(root\)/);
  assert.match(frontdesk,/if\s*\(!alive\(\)\)\s*return/);
});

test('AC-FD-NAV-006: static build explicitly versions standalone entry and keeps old pages',()=>{
  const build=fs.readFileSync(path.join(root,'..','scripts','build-site.mjs'),'utf8');
  assert.match(build,/'admin\/frontdesk-settings\/index\.html'/);
  assert.match(build,/'admin\/index\.html'/);
  assert.match(build,/'admin\/workspace\.html'/);
});

test('AC-FD-UX-001: frontdesk settings omits redundant setup links and onboarding list',()=>{
  for(const label of [
    '開啟 LINE Official Account Manager',
    '開啟 LINE Developers',
    '開啟 LINE Developers 取得登入參數',
    '開啟櫃檯 LINE 入口',
    '開啟櫃檯專屬申請頁',
    '加入櫃檯官方帳號'
  ]) assert.equal(frontdesk.includes(label),false,label);
  assert.doesNotMatch(frontdesk,/frontdesk-setup-guide|frontdesk-quick-links/);
  assert.match(frontdesk,/複製 Endpoint URL/);
  assert.match(frontdesk,/驗證並儲存櫃檯設定/);
  assert.match(frontdesk,/platform\.frontdesk\.staff\.save/);
});

test('AC-FD-UX-002: empty applicant state explains the remaining request path',()=>{
  assert.doesNotMatch(frontdesk,/請分享上方/);
  assert.match(frontdesk,/目前沒有申請。櫃檯人員請透過商家專屬 frontdesk 頁面提出申請。/);
});

test('AC-FD-NAV-007: an existing external LINE session must not be forcibly logged out on navigation', () => {
  const script=read('admin/frontdesk-settings/frontdesk-settings-page.js');
  assert.doesNotMatch(script,/if\s*\(!window\.liff\.isInClient\(\)\s*&&\s*!returned\)\s*\{\s*beginLogin\(/);
  assert.match(script,/if\s*\(reauthenticate\)\s*\{\s*beginLogin\(\{\s*force:\s*true\s*\}\)/);
  // User requirement supersedes the old fallback: forced browser logout
  // invalidates other LINE tabs. Reentry must use this merchant's LIFF.
  assert.doesNotMatch(script,/liff\.logout\(/);
  assert.match(script,/liff\.line\.me/);
  assert.match(script,/LineInitialEntry\?\.enter\(/);
});

test('AC-FD-UX-003: standalone page uses readable, concise merchant-specific headings', () => {
  const html=read('admin/frontdesk-settings/index.html');
  const script=read('admin/frontdesk-settings/frontdesk-settings-page.js');
  assert.doesNotMatch(html,/BUSINESS \/ FRONTDESK/);
  assert.match(html,/櫃檯登入、預約通知與人員權限/);
  assert.doesNotMatch(script,/data\.tenant\.name\s*\+\s*'｜櫃檯設定'/);
  assert.match(frontdesk,/櫃檯人員申請與權限/);
});

test('AC-FD-HIST-006: server action is tenant-authorized, read-only and migration is least-privilege',()=>{
 const handler=read('supabase/functions/_shared/platform-handler.mjs');
 const admin=read('supabase/functions/_shared/frontdesk-admin.mjs');
 const sql=read('supabase/migrations/20261121180000_frontdesk_review_history.sql');
 const html=read('admin/frontdesk-settings/index.html');
 const css=read('admin/frontdesk-settings/frontdesk-settings-page.css');
 assert.match(frontdesk,/frontdesk-settings-tabs/);
 for(const label of ['LINE 設定','確認預約','拒絕預約'])
  assert.ok(frontdesk.includes(label));
 assert.ok(frontdesk.includes('platform.frontdesk.history.list'));
 assert.ok(handler.includes('platform.frontdesk.history.list'));
 assert.match(admin,/platform_frontdesk_history/);
 assert.match(sql,/require_merchant_access/);
 assert.ok(sql.includes('t.runtime_schema'));
 assert.match(sql,/actor_role='frontdesk'/);
 assert.match(sql,/limit 50/);
 assert.match(sql,/from public, anon, authenticated/);
 assert.match(sql,/to service_role/);
 assert.match(sql,/frontdesk_paired_phone_source/);
 assert.match(css,/frontdesk-history-card/);
 assert.match(css,/frontdesk-settings-body/);
 assert.match(css,/scrollbar-gutter: stable/);
 assert.match(css,/\.frontdesk-settings-body > button/);
 assert.doesNotMatch(css,/\.frontdesk-settings > button/);
 assert.match(frontdesk,/body\.append\(status, syncState, reload, tabs, content, historyPanel\)/);
 assert.match(html,/frontdesk-line-flow-20261122-1/);
});

test('AC-FD-LINE-001: LINE settings follow one ordered track; only provider cards share desktop columns',()=>{
 const css=read('admin/frontdesk-settings/frontdesk-settings-page.css');
 const page=read('admin/frontdesk-settings/index.html');
 assert.match(css,/\.frontdesk-settings-content\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
 assert.match(css,/@media \(min-width: 1080px\)\s*\{\s*html\[data-frontdesk-page\] \.frontdesk-config-form\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
 assert.doesNotMatch(css,/grid-template-columns:\s*minmax\(0, 1\.15fr\) minmax\(0, \.85fr\)/);
 assert.match(css,/\.frontdesk-settings \.frontdesk-preferences-form\s*\{\s*margin:\s*0/);
 assert.match(page,/frontdesk-line-flow-20261122-1/);
});


test('AC-LINE-017: standalone merchant frontdesk settings also starts via the merchant-specific LIFF without cross-tab logout',()=>{
 const html=read('admin/frontdesk-settings/index.html');
 const js=read('admin/frontdesk-settings/frontdesk-settings-page.js');
 assert.match(html,/line-initial-entry\.js/);
 assert.match(js,/LineInitialEntry\?\.enter\(/);
 assert.match(js,/scope:\s*'merchant-frontdesk-settings'/);
 assert.doesNotMatch(js,/liff\.logout\(/);
 assert.match(js,/https:\/\/liff\.line\.me\//);
 assert.match(js,/platform\.application\.bootstrap/);
});


test('AC-LINE-018: real standalone recovery handler uses merchant LIFF, never browser-shared logout',()=>{
 const source=read('admin/frontdesk-settings/frontdesk-settings-page.js');
 const start=source.indexOf('  function beginLogin({ force = false } = {}) {');
 const end=source.indexOf('  async function request(',start);
 assert.ok(start>=0&&end>start,'actual login handler remains independently exercised');
 const calls=[],storage=new Map();
 const context={
  URL,Date,RETURN_KEY:'frontdesk-settings-line-return-v1',
  markAttempt:()=>true, idToken:'expired-id-token',config:{adminLiffId:'2010791619-MerchantFixture'},business:'shop-a',
  sessionStorage:{setItem(k,v){storage.set(k,v);},removeItem(k){storage.delete(k);}},
  window:{liff:{isLoggedIn:()=>true,isInClient:()=>false,logout(){calls.push('global-logout');},login(){calls.push('login');}}},
  location:{replace(url){calls.push(['replace',url]);},reload(){calls.push('reload');}},
  setStatus(message){calls.push(['status',message]);},dismiss(message){calls.push(['dismiss',message]);}
 };
 const login=vm.runInNewContext('('+source.slice(start,end).trim()+')',context);
 login({force:true});
 const redirects=calls.filter(x=>Array.isArray(x)&&x[0]==='replace');
 assert.equal(redirects.length,1);
 const url=new URL(redirects[0][1]);
 assert.equal(url.origin,'https://liff.line.me');
 assert.equal(url.pathname,'/2010791619-MerchantFixture');
 assert.equal(url.searchParams.get('business'),'shop-a');
 assert.equal(url.searchParams.get('line_initial'),'1');
 assert.equal(calls.includes('global-logout'),false);
 assert.equal(calls.includes('login'),false,'existing logged-in browser reenters only current LINE LIFF');
 assert.ok(storage.get('frontdesk-settings-line-return-v1'));
 assert.equal(context.idToken,'','old ID token discarded before navigation');
});
