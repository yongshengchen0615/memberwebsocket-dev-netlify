const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const base = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(base,name),'utf8');
const shared = name => import(pathToFileURL(path.join(base,'supabase/functions/_shared',name)));
const brand = '晨光工作室';
const pageLabels = {booking:'預約',member:'會員卡',points:'集點卡',event:'活動票券',calendar:'活動日曆'};

async function renderTitle(page, tenant, scoped = true) {
  const pathname = '/' + page + '/';
  const location = {pathname,origin:'https://example.test',search:scoped?'?business=merchant-a':'',
    href:'https://example.test'+pathname+(scoped?'?business=merchant-a':'')};
  const calls=[];
  const document={title:'',documentElement:{},addEventListener(){},querySelectorAll(){return [];}};
  const window={location,fetch:async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    return {ok:true,json:async()=>({ok:true,data:tenant})};
  }};
  const context={window,document,location,URL,URLSearchParams};
  vm.runInNewContext(read('business-context.js'),context);
  await window.BusinessContext.configure({
    supabaseFunctionUrl:'https://db.example.supabase.co/functions/v1/api',
    supabasePublishableKey:'public-test-key',
  });
  return {title:document.title,calls};
}

test('AC-001: five public surfaces use the same merchant title, brand first',async()=>{
  for(const [page,label] of Object.entries(pageLabels)){
    const result=await renderTitle(page,{business:'merchant-a',name:'原本商家名稱',siteTitle:brand,features:{},line:{}});
    assert.equal(result.title,brand+'｜'+label);
    assert.equal(result.calls.length,1);
    assert.equal(result.calls[0].body.business,'merchant-a');
  }
});

test('AC-002: blank custom title falls back to merchant name; unscoped pages retain Lumen Club',async()=>{
  for(const [page,label] of Object.entries(pageLabels)){
    const tenant=await renderTitle(page,{business:'merchant-a',name:'原本商家名稱',siteTitle:null,features:{},line:{}});
    assert.equal(tenant.title,'原本商家名稱｜'+label);
    const legacy=await renderTitle(page,{},false);
    assert.equal(legacy.title,'Lumen Club｜'+label);
    assert.equal(legacy.calls.length,0);
    const html=read(page+'/index.html');
    assert.ok(html.includes('<title>Lumen Club｜'+label+'</title>'));
    assert.ok(html.includes('../business-context.js'));
  }
});

test('AC-003: tenant projection exports only independent public siteTitle',async()=>{
  const {publicTenant}=await shared('platform-policy.mjs');
  const result=publicTenant({id:'id',name:'合法商家名稱',site_title:brand,slug:'merchant-a',features:{},line_config:{},
    status:'active',version:2,created_by:'SECRET',credentials_configured:true});
  assert.equal(result.name,'合法商家名稱');
  assert.equal(result.siteTitle,brand);
  assert.doesNotMatch(JSON.stringify(result),/SECRET|created_by/);
});

test('AC-004: missing LINE token and invalid title fail closed before tenant mutation',async()=>{
  const {createPlatformHandler}=await shared('platform-handler.mjs');
  const names=[];
  const handler=createPlatformHandler({
    db:{rpc:async name=>{names.push(name);return {data:name==='platform_business_context'?{id:'10000000-0000-4000-8000-000000000001',slug:'merchant-a',name:'商家',status:'active',features:{membership:true},line_config:{adminChannelId:'2010791619',adminLiffId:'2010791619-admin'},isolation_verified_at:'2026-10-01',isolation_version:'business-v1-20261019',runtime_schema:'business_'+'1'.repeat(32)}:true};}},
    verifyIdentity:async()=>({lineUserId:'U'+'1'.repeat(32),issuedAtMs:Date.now()}),
    allowedOrigins:new Set(['https://example.test']),encryptionKey:()=> 'not-used',
  });
  const call=async(body)=>{
    const res=await handler(new Request('https://api.test',{method:'POST',
      headers:{Origin:'https://example.test'},body:JSON.stringify({action:'platform.title.save',...body})}));
    return {status:res.status,json:await res.json()};
  };
  assert.equal((await call({title:brand,business:'merchant-a'})).status,401);
  assert.equal((await call({idToken:'id',title:'x'.repeat(61),business:'merchant-a',
    requestId:'10000000-0000-4000-8000-000000000001',expectedVersion:1})).status,400);
  assert.equal(names.includes('platform_save_title_for_merchant'),false);
});

test('AC-005: merchant title migration scopes writes, audits, versions and blocks public RPC access',()=>{
  const sql=fs.readFileSync(path.join(base,'supabase/migrations/20261102113000_merchant_client_page_titles.sql'),'utf8');
  assert.match(sql,/require_merchant_access\(p_actor, p_tenant_id, p_issued_at\)/);
  assert.match(sql,/v_tenant.version <> p_expected_version/);
  assert.match(sql,/platform_private.requests/);
  assert.match(sql,/MERCHANT_SITE_TITLE_UPDATED/);
  assert.match(sql,/revoke all on function public.platform_save_title_for_merchant/);
  assert.match(sql,/from public, anon, authenticated/);
});
