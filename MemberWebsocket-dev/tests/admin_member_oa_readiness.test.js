const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=filename=>fs.readFileSync(path.join(root,filename),'utf8');
const admin=read('admin/business-line-settings.js');
const css=read('admin/business-line-settings.css');
const adminEntry=read('admin/index.html');
const merchantEntry=read('admin/workspace.html');
const platformClient=read('platform/app.js');
const backend=read('supabase/functions/_shared/platform-handler.mjs');
const production=read('supabase/functions/platform-api/index.ts');
const preview=read('supabase/functions/platform-api-preview/index.ts');

test('RB-ADMIN-001: October 27 merchant member card LINE fields and save flow remain available',()=>{
 assert.match(admin,/membership: \['members', '會員卡', 'member', 'memberLiffId'\]/);
 assert.match(admin,/addField\(form, key, '1\. 貼上'/);
 assert.match(admin,/addField\(account,'memberChannelId'/);
 assert.match(admin,/request\('platform\.line\.save', view\.pending\)/);
 assert.match(admin,/request\('platform\.application\.bootstrap'\)/);
});

test('RB-ADMIN-002: no October 28 OA readiness banner, inspection buttons or implicit preflight',()=>{
 for(const source of [admin,css,adminEntry,merchantEntry]) {
  assert.doesNotMatch(source,/memberOaAdminReadinessNotice|member-registration-readiness|member-oa-admin-notice|renderMemberReadiness|checkMemberReadiness|inspectMemberOa/);
  assert.doesNotMatch(source,/重新檢查會員入會設定|由 LINE 自動辨識我的官方帳號|前往會員 LINE 必要設定/);
 }
 assert.doesNotMatch(admin,/platform\.member-oa\.(readiness|inspect)/);
 assert.doesNotMatch(platformClient,/platform\.member-oa\.(readiness|inspect)/);
});

test('RB-ADMIN-003: user-requested removal of unrelated testing and usage management survives rollback',()=>{
 assert.doesNotMatch(admin,/testing: \['testMode'|usage: \['operationAudit'/);
 assert.match(admin,/integrations: \['operationsHub', '整合中心'\]/);
 assert.doesNotMatch(adminEntry,/src="\.\/operation-audit\.js|src="\.\/admin-quick-actions\.js/);
});

test('RB-ADMIN-004: both manager entrypoints load the restored settings and bust newer cached assets',()=>{
 for(const html of [adminEntry,merchantEntry]){
  assert.match(html,/business-line-settings\.js\?v=member-card-admin-rollback-20261028-1/);
  assert.match(html,/business-line-settings\.css\?v=member-card-admin-rollback-20261028-1/);
 }
 assert.match(merchantEntry,/platform\/app\.js\?v=member-card-admin-rollback-20261028-1/);
 assert.match(platformClient,/url\.pathname\.replace\(\/\\\/api\\\/\?\$\/, '\/platform-api'\)/);
 assert.doesNotMatch(platformClient,/readOnlyPreview/);
});

test('RB-ADMIN-005: keep server-only OA authorization and tenant-scoped preflight despite retired UI',()=>{
 assert.match(backend,/memberOaGuidance\(/);
 assert.match(backend,/body\.action === 'platform\.member-oa\.readiness'/);
 assert.match(backend,/workspace\.application\?\.status !== 'approved'/);
 assert.match(backend,/current\.features\?\.membership !== true/);
 assert.match(backend,/verifiedBindingsJson:verifiedMemberOaBindingsJson/);
 assert.match(production,/verifiedMemberOaBindingsJson:env\('MEMBER_OA_VERIFIED_LINKS_JSON'\)/);
 assert.doesNotMatch(backend,/configured:body\./);
});

test('RB-ADMIN-006: retired UI cannot invoke preview API; retained API remains read-only and tenant authorized',()=>{
 assert.match(preview,/allowedActions:new Set\(\['platform\.member-oa\.readiness','platform\.member-oa\.inspect'\]\)/);
 assert.match(backend,/if \(allowedActions && !allowedActions\.has\(body\.action\)\)/);
 assert.doesNotMatch(preview,/allowedActions:new Set\(\['platform\.line\.save'/);
 assert.doesNotMatch(admin,/platform-api-preview/);
 assert.doesNotMatch(platformClient,/platform-api-preview/);
});
