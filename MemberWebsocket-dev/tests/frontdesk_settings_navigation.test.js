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
  assert.match(platform,/actions\.append\(manage,frontdesk\)/);
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
  assert.match(frontdesk,/mounted\.delete\(root\)/);
  assert.match(frontdesk,/if\(!alive\(\)\) return/);
});

test('AC-FD-NAV-004: deep links do not bypass booking grants or force LINE settings',()=>{
  assert.match(business,/data\.features\.booking===true/);
  assert.match(business,/get\('settings'\)==='frontdesk'/);
  assert.match(business,/selectFrontdeskTab\(\)/);
  assert.match(platform,/tenant\.features\?\.booking===true/);
  assert.match(platform,/get\('settings'\)==='frontdesk'/);
});

test('AC-FD-NAV-005: existing frontdesk approval and notification operations remain unchanged',()=>{
  assert.match(frontdesk,/platform\.frontdesk\.settings\.save/);
  assert.match(frontdesk,/platform\.frontdesk\.staff\.save/);
  assert.match(frontdesk,/platform\.frontdesk\.get/);
});
