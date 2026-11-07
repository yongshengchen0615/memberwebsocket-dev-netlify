const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');

// Product removal must be proven across merchant UI, root grants, and server policy.
// Historical grant fields remain as false-only compatibility inputs until the SQL
// eight-key contract has a separately reviewed migration.
test('AC-RET-001: merchant LINE settings contain neither retired product panel',()=>{
 const html=source('admin/workspace.html'),script=source('admin/business-line-settings.js');
 assert.doesNotMatch(html,/data-merchant-panel="(?:testing|usage)"/);
 assert.doesNotMatch(script,/testing:\s*\['testMode'/);
 assert.doesNotMatch(script,/usage:\s*\['operationAudit'/);
});
test('AC-RET-002: root grant and merchant UI cannot display retired products',()=>{
 const app=source('platform/app.js');
 assert.match(app,/const visibleFeatureKeys=featureKeys\.filter\(key=>key!=='integrations'&&key!=='testing'&&key!=='usage'\)/);
 assert.match(app,/Object\.entries\(state\.features\)\.filter\(\(\[key\]\)=>visibleFeatureKeys\.includes\(key\)\)/);
 assert.match(app,/visibleFeatureKeys\.includes\(key\)&&tenant\.features\[key\]/);
 assert.match(app,/visibleFeatureKeys\.includes\(key\) && tenant\.features\[key\]/);
 assert.match(app,/visibleFeatureKeys\.includes\(key\)&&tenant\.features\?\.\[key\]/);
 assert.match(app,/Object\.entries\(data\.features\)\.filter\(\(\[key\]\)=>visibleFeatureKeys\.includes\(key\)\)/);
});
test('AC-RET-003: old grant keys can only be submitted disabled to the unchanged SQL validator',()=>{
 const app=source('platform/app.js');
 assert.match(app,/featureKeys\.map\(key=>\[key,visibleFeatureKeys\.includes\(key\) && Boolean\(form\.querySelector/);
 assert.match(app,/featureKeys\.map\(key=>\[key,visibleFeatureKeys\.includes\(key\) && Boolean\(grantForm\.querySelector/);
 assert.match(app,/featureKeys\.map\(key=>\[key,visibleFeatureKeys\.includes\(key\) && el\('v2ReviewFeatures'\)/);
});
test('AC-RET-005: server rejects retired audit but leaves protected membership history available',()=>{
 const policy=source('supabase/functions/_shared/business-policy.mjs');
 assert.match(policy,/if\(action==='admin\.audit\.query'\)return null/);
 assert.match(policy,/if\(action==='admin\.member-records\.list'\)return \['membership'\]/);
 assert.match(source('admin/index.html'),/id="memberUsageTab"/);
});
