const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),repo=path.resolve(root,'..'),read=p=>fs.readFileSync(path.resolve(root,p),'utf8');
test('AC-201: retired product screens and menu entries are absent; member usage remains',()=>{
 const admin=read('admin/index.html'),platform=read('platform/index.html'),workspace=read('admin/business-workspace.js');
 assert.doesNotMatch(admin,/operation-audit\.(js|css)/);
 assert.doesNotMatch(admin,/integration-hub\.(?:js|css)|operationsHub(?:Tab|Panel)/);
 assert.equal(fs.existsSync(path.join(root,'admin/integration-hub.js')),false);
 assert.doesNotMatch(platform,/data-merchant-panel="(?:testing|usage)"/);
 assert.doesNotMatch(workspace,/testing:'testMode'|features\.usage/);
 assert.match(admin,/id="memberUsageTab"/);
});
test('AC-202: integration API no longer fetches audit timelines, but persists required audit events',()=>{
 const api=read('supabase/functions/api/index.ts');
 assert.doesNotMatch(api,/\bauditTimeline\b|\bauditRes\b|\bbookingAuditRes\b|admin_query_operation_audit/);
 assert.match(api,/supabase\.from\("audit_logs"\)\.insert/);
 assert.match(api,/supabase\.from\("booking_audit_events"\)\.insert/);
});
test('AC-203: legacy grants cannot re-enable retired testing and audit products via merchant UI',()=>{
 const app=read('platform/app.js');
 assert.match(app,/const visibleFeatureKeys=featureKeys\.filter/);
 assert.match(app,/visibleFeatureKeys\.includes\(key\) &&/);
 assert.match(app,/merchantPanel=feature==='shared'\|\|\(visibleFeatureKeys\.includes\(feature\)/);
});
test('AC-204: admin QA scripts are excluded from public Netlify builds',()=>{
 const build=fs.readFileSync(path.join(repo,'scripts/build-site.mjs'),'utf8');
 for(const a of ['test-mode.js','test-control.js','test-workspace-tabs.js','e2e-control.js','e2e-control-loader.js','e2e-flow-visualizer.js']) assert.ok(build.includes("'"+a+"'"),a);
 assert.match(build,/retiredAdminAssets\.has\(path\.basename\(file\)\)/);
});
