const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const pages = { member:'會員卡', points:'集點卡', event:'活動票券', calendar:'活動日曆', booking:'預約' };

test('AC-001: merchant pages do not paint the old brand before the current title loads', () => {
  for (const [surface, label] of Object.entries(pages)) {
    const html = read(surface + '/index.html');
    assert.match(html, new RegExp('<title>會員系統｜' + label + '</title>'), surface);
    assert.doesNotMatch(html, /Lumen Club\s*\/(?: Booking| Member pass| Rewards| Member event| Member calendar)|<title>Lumen Club|id="brandName">Lumen Club/, surface);
  }
});

function fixture(surface = 'member') {
  const location = new URL('https://app.test/' + surface + '/?business=shop-a');
  let complete;
  const window = {
    location, setTimeout, clearTimeout,
    fetch: async () => new Promise(resolve => { complete = resolve; }),
  };
  const header = {dataset:{tenantBrand:surface==='member'?'Member pass':'Booking'},textContent:'會員系統'};
  const document = { title:'會員系統｜' + pages[surface], documentElement:{},
    querySelectorAll: selector => selector==='[data-tenant-brand]'?[header]:[], addEventListener() {} };
  vm.runInNewContext(read('business-context.js'), { window, location, document, URL, URLSearchParams, AbortController, Response });
  const config = () => ({ supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey:'synthetic' });
  const finish = (business, siteTitle, name) => complete(Response.json({ok:true,data:{
    business, siteTitle, name, line:{}, features:{membership:true,points:true,events:true,calendar:true,booking:true},
  }}));
  return { window, document, header, config, finish };
}

test('AC-002: title stays neutral while tenant config is pending and resolves to saved title or business name', async () => {
  const f = fixture();
  const next = f.window.BusinessContext.configure(f.config());
  assert.equal(f.document.title, '會員系統｜會員卡');
  await Promise.resolve();
  f.finish('shop-a', '晨光工作室', '商家登記名稱');
  await next;
  assert.equal(f.document.title, '晨光工作室｜會員卡');
  assert.equal(f.header.textContent, '晨光工作室 / Member pass');

  f.window.BusinessContext.set('shop-b');
  assert.equal(f.document.title, '會員系統｜會員卡', 'a new tenant cannot inherit the previous tenant name');
  assert.equal(f.header.textContent, '會員系統 / Member pass');
  const nextB = f.window.BusinessContext.configure(f.config());
  await Promise.resolve();
  f.finish('shop-b', null, '新商家');
  await nextB;
  assert.equal(f.document.title, '新商家｜會員卡');
  assert.equal(f.header.textContent, '新商家 / Member pass');
});

test('AC-003: merchant failed startup never leaks another tenant title', async () => {
  const f = fixture('booking');
  const pending = f.window.BusinessContext.configure(f.config());
  await Promise.resolve();
  f.finish('shop-a', '自訂商家', '登記商家');
  await pending;
  f.window.BusinessContext.set('shop-b');
  assert.equal(f.document.title, '會員系統｜預約');
});

test('AC-004: all booking and membership Flex footers use tenant title rather than a hard-coded legacy brand', () => {
  const delivery = read('supabase/functions/booking-line-notifications/delivery.ts');
  const notice = read('supabase/functions/_shared/line-flex.ts');
  assert.doesNotMatch(delivery, /Lumen Club 預約系統/);
  assert.doesNotMatch(notice, /Lumen Club 會員系統|LUMEN CLUB/);
  assert.match(delivery, /brandName/);
  assert.match(notice, /options\.footer/);
});
