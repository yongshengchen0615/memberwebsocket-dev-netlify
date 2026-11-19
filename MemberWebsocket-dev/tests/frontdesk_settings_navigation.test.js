const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const platform=read('platform/app.js');
const admin=read('admin/index.html');
const merchant=read('admin/workspace.html');
const business=read('admin/business-workspace.js');
const line=read('admin/business-line-settings.js');
const frontdesk=read('admin/frontdesk-settings.js');

test('AC-FD-NAV-001: each approved merchant has distinct manage-business and frontdesk entry points',()=>{
  assert.match(platform,/manage\.textContent='管理商家'/);
  assert.match(platform,/frontdesk\.textContent='櫃檯設定'/);
  assert.match(platform,/frontdesk\.href='\/admin\/\?business='\+encodeURIComponent\(application\.slug\)\+'&settings=frontdesk'/);
  assert.match(platform,/actions\.append\(manage\)/);
  assert.match(platform,/actions\.append\(frontdesk\)/);
  assert.match(platform,/tenant\?\.features\?\.frontdesk===true/);
});

test('AC-FD-NAV-002: frontdesk gets its own accessible tab/panel outside LINE settings on both merchant workspaces',()=>{
  for(const [html,tab,panel]of [
    [admin,'frontdeskSettingsTab','frontdeskSettingsPanel'],
    [merchant,'merchantFrontdeskSettingsTab','merchantFrontdeskSettingsPanel']
  ]){
    assert.equal((html.match(new RegExp('id="'+tab+'"','g'))||[]).length,1);
    assert.equal((html.match(new RegExp('id="'+panel+'"','g'))||[]).length,1);
    assert.match(html,new RegExp('id="'+tab+'"[^>]*role="tab"[^>]*aria-controls="'+panel+'"'));
    assert.match(html,new RegExp('id="'+panel+'"[^>]*role="tabpanel"[^>]*aria-labelledby="'+tab+'"'));
    assert.match(html,/data-frontdesk-settings-root/);
  }
  assert.match(admin,/id="frontdeskSettingsTab"[^>]*data-business-allowed="false"[^>]*hidden disabled/);
});

test('AC-FD-NAV-003: frontdesk no longer mounts inside the booking LINE feature and is cleaned up on revoke',()=>{
  assert.doesNotMatch(line,/if\(feature==='booking'\)window\.FrontdeskSettings\?\.mount\(\{root:section/);
  assert.match(line,/querySelector\('\[data-frontdesk-settings-root\]'\)/);
  assert.match(line,/window\.FrontdeskSettings\?\.clear\(/);
  assert.match(line,/adapter\?\.root\?\.closest\?\.\('#merchantWorkspace'\)/);
  assert.match(line,/document\.querySelector\('#adminView'\)/);
  assert.doesNotMatch(line,/document\.querySelector\('\[data-frontdesk-settings-root\]'\)/);
  assert.match(frontdesk,/mounted\.delete\(root\)/);
  assert.match(frontdesk,/if\s*\(!alive\(\)\)\s*return/);
});

test('AC-FD-NAV-004: deep links do not bypass booking grants or force LINE settings',()=>{
  assert.match(business,/data\.features\.booking===true/);
  assert.match(business,/get\('settings'\)==='frontdesk'/);
  assert.match(business,/selectFrontdeskTab\(\)/);
  assert.match(platform,/tenant\?\.features\?\.booking===true/);
  assert.match(platform,/get\('settings'\)==='frontdesk'/);
});

test('AC-FD-NAV-005: existing frontdesk approval and notification operations remain unchanged',()=>{
  assert.match(frontdesk,/platform\.frontdesk\.settings\.save/);
  assert.match(frontdesk,/platform\.frontdesk\.staff\.save/);
  assert.match(frontdesk,/platform\.frontdesk\.get/);
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
