const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function fixture() {
  const panel = { hidden: true };
  const attributes = {};
  const link = {
    setAttribute(key, value) { attributes[key] = value; },
    removeAttribute(key) { delete attributes[key]; },
    getAttribute(key) { return attributes[key] ?? null; },
  };
  const window = { location: { origin: 'https://preview.example.test' } };
  const document = { getElementById: id => ({
    clientPageTitleShortcut: panel, clientPageTitleSettingsLink: link,
  })[id] };
  vm.runInNewContext(read('admin/client-title-shortcut.js'), {
    window, document, URL, Object, String, Boolean,
  });
  return { panel, link, client: window.ClientPageTitleShortcut };
}

test('AC-006: actual business admin exposes a plainly labeled title settings section and secure destination', () => {
  const html = read('admin/index.html');
  const js = read('admin/app.js');
  assert.match(html, /id="clientPageTitleShortcut"[^>]*hidden/);
  assert.match(html, /id="clientPageTitleShortcutHeading">用戶端網頁抬頭/);
  assert.match(html, /id="clientPageTitleSettingsLink"[^>]*>修改用戶端網頁抬頭/);
  assert.match(html, /client-title-shortcut\.js\?v=/);
  assert.match(js, /view === 'admin'\) window\.ClientPageTitleShortcut\?\.sync\(state\.config\)/);
  assert.match(js, /else window\.ClientPageTitleShortcut\?\.clear\(\)/);
  assert.match(read('admin/workspace.html'), /id="merchantTitleForm"/);
  assert.match(read('admin/workspace.html'), /id="saveMerchantTitle"/);
});

test('AC-007: only scoped merchant sessions produce a settings link, without trusting the link as authorization', () => {
  const { panel, link, client } = fixture();
  client.sync({ productizedAdmin: true, business: 'merchant-a' });
  assert.equal(panel.hidden, false);
  assert.equal(link.getAttribute('href'), '/admin/workspace.html?business=merchant-a');
  client.sync({ productizedAdmin: true, business: 'merchant-b' });
  assert.equal(panel.hidden, false);
  assert.equal(link.getAttribute('href'), '/admin/workspace.html?business=merchant-b');

  for (const config of [null, {}, { productizedAdmin: true },
    { productizedAdmin: false, business: 'merchant-a' },
    { productizedAdmin: true, business: '../platform' },
    { productizedAdmin: true, business: 'merchant-a?feature=line' },
    { productizedAdmin: true, business: 'merchant-a#fragment' }]) {
    client.sync(config);
    assert.equal(panel.hidden, true);
    assert.equal(link.getAttribute('href'), null);
  }
  client.sync({ productizedAdmin: true, business: 'merchant-a' });
  client.clear();
  assert.equal(panel.hidden, true);
  assert.equal(link.getAttribute('href'), null);
});
