const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {startFixture}=require('./browser/admin-fixture.cjs');

test('AC-FIX-001: isolated admin fixture never blocks on remote map CSS but retains full local UI assets',async()=>{
  const original=fs.readFileSync(path.resolve(__dirname,'../admin/index.html'),'utf8');
  assert.match(original,/href="https:\/\/cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4\/dist\/leaflet\.css"/,
    'production page must stay unchanged');

  const host=await startFixture();
  try {
    const response=await fetch(host.base+'/admin/?run=local-fixture-isolation');
    assert.equal(response.status,200);
    const html=await response.text();
    assert.doesNotMatch(html,/href="https:\/\/cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4\/dist\/leaflet\.css"/,
      'the shared synthetic browser page must not fetch unrelated external map CSS');
    assert.match(html,/rel="stylesheet" href="\.\/styles\.css/,
      'actual local admin CSS is still loaded');
    assert.match(html,/src="\/admin\/app\.js"/,
      'actual local admin UI handlers are still loaded');
    assert.match(html,/id="adminView"/,
      'all management markup remains intact');
    assert.match(html,/src="\/fixture\.js"/,
      'the synthetic isolated API remains installed');
  }finally{
    await host.close();
  }
});
