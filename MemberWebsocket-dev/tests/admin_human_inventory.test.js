const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const matrix=require('./browser/admin-human-coverage.json');
const spec=path.join(root,'tests/browser/admin-human.spec.cjs');
const titles=[];
const register=(title)=>titles.push(title.split(' — ')[0]);
for(const name of ['beforeAll','afterAll','beforeEach','afterEach'])register[name]=()=>{};
const req=createRequire(spec);
const source=fs.readFileSync(spec,'utf8');
vm.runInThisContext('(function(require,module,exports,__dirname){'+source+'\n})',{filename:spec})(name=>name==='playwright/test'?{test:register,expect:{}}:req(name),{exports:{}},{},path.dirname(spec));

test('each audited admin workflow maps to executable browser tests without orphan cases',()=>{
  assert.equal(new Set(titles).size,titles.length,'Duplicate test node IDs');
  const mapped=new Set(matrix.features.flatMap(row=>row.cases));
  assert.deepEqual([...mapped].sort(),[...titles].sort(),'Missing or unmapped human workflow');
  for(const module of ['member','points','event','calendar','integration','booking'])assert.ok(matrix.features.some(row=>row.module===module));
  for(const row of matrix.features)assert.ok(row.name&&row.cases.length,row.id);
});
test('UI changes require reviewing the feature inventory and its browser journeys',()=>{
  for(const [file,reviewed] of Object.entries(matrix.reviewedSources)){
    const current=createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
    assert.equal(current,reviewed,file+' changed: review new/removed workflows and update admin-human-coverage.json with matching journeys');
  }
});
