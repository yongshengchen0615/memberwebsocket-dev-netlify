const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'admin/index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'admin/ui-polish-responsive.css'),'utf8');

test('AC-AR-001: scoped responsive stylesheet and accessible mobile nav cue',()=>{
  assert.match(html,/ui-polish-responsive\.css\?v=[^"]*adaptive-20261122-1/);
  assert.match(html,/<nav class="surface-nav"[^>]*aria-describedby="adminNavScrollHint"/);
  assert.match(html,/<p id="adminNavScrollHint" class="surface-nav-hint">左右滑動/);
  assert.match(css,/#adminView \.surface-nav-hint \{\s*display: block/);
  assert.match(css,/#adminView > \.surface-nav::?-webkit-scrollbar|#adminView > \.surface-nav::-webkit-scrollbar/);
});
test('AC-AR-002/003: tablet, mobile and landscape dialog rules are present',()=>{
  assert.match(css,/@media \(min-width: 761px\) and \(max-width: 980px\)/);
  assert.match(css,/@media \(max-width: 760px\)/);
  assert.match(css,/@media \(max-height: 500px\) and \(orientation: landscape\)/);
  assert.match(css,/\.modal-card:not\(\.member-records-modal-card\)/);
});
test('AC-AR-004/005: member table is keyboard scrollable; existing auth tabs remain gated',()=>{
  assert.match(html,/class="table-wrap" tabindex="0" role="region" aria-label="會員名冊表格（可左右捲動）"/);
  for(const id of ['lineSettingsTab','clientPageTitleTab']){
    assert.match(html,new RegExp('id="'+id+'"[^>]*data-business-allowed="false"[^>]*hidden disabled'));
  }
  assert.match(css,/#adminView \.table-wrap:focus-visible/);
});

const businessWorkspace=fs.readFileSync(path.join(root,'admin/business-workspace.js'),'utf8');
test('AC-AR-006: approved merchant banner keeps a separate, accessible mobile return action',()=>{
  assert.match(businessWorkspace,/status\.id='businessWorkspaceStatus'/);
  assert.match(businessWorkspace,/status\.setAttribute\('role','status'\)/);
  assert.match(businessWorkspace,/back\.href='\/admin\/'/);
  assert.match(html,/ui-polish-responsive\.css\?v=[^"]*merchant-status-20261128-1/);
  assert.match(css,/#adminView > #businessWorkspaceStatus \{[^}]*display: flex/);
  assert.match(css,/@media \(max-width: 760px\) \{\s*#adminView > #businessWorkspaceStatus \{[^}]*display: grid/);
  assert.match(css,/#adminView > #businessWorkspaceStatus > a\[data-business-switch\]/);
});
