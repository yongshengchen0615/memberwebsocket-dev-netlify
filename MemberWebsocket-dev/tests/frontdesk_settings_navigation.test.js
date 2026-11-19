const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
