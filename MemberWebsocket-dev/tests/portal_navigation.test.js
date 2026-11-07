const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'portal-navigation.js'), 'utf8');
function documentFor(surface) {
  const nodes = [], listeners = {};
  const createElement = name => ({
    name, attributes: {}, dataset: {}, children: [], className: '', textContent: '', href: '',
    setAttribute(key, value) { this.attributes[key] = value; },
    append(child) { this.children.push(child); },
  });
  const body = {
    firstElementChild: null,
    querySelector() { return null; },
    append(node) { nodes.push(node); },
  };
  const document = {
    documentElement: { dataset: { portalSurface: surface } },
    body, readyState: 'complete', createElement,
    getElementById(id) { return nodes.find(node => node.id === id); },
    addEventListener(name,callback) { listeners[name]=callback; },
    querySelector() { return nodes.flatMap(node=>node.children).find(node=>node.dataset.portalEntry==='member'); },
  };
  return { document, nodes, listeners };
}
test('AC-030/AC-301: navigation stays within the current role and never exposes cross-role entrances', () => {
  for (const surface of ['platform', 'admin', 'member']) {
    const { document, nodes } = documentFor(surface);
    vm.runInNewContext(script, { document });
    if(surface!=='admin'){assert.equal(nodes.length,0,'only admin has an upper system entrance');continue;}
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].attributes['aria-label'].includes('獨立驗證'), true);
    const links = nodes[0].children.filter(item => item.name === 'a');
    assert.deepEqual(links.map(item => item.href), [{platform:'/platform/',admin:'/admin/',member:'/member/'}[surface]]);
    assert.equal(links.filter(item => item.attributes['aria-current'] === 'page').length, 1);
    assert.equal(links.find(item => item.attributes['aria-current'] === 'page').href,
      { platform:'/platform/', admin:'/admin/', member:'/member/' }[surface]);
    vm.runInNewContext(script, { document });
    assert.equal(nodes.length, 1, 'navigation is not duplicated');
  }
});
test('AC-104: productized admin never links into the legacy unscoped member runtime',()=>{
  const {document,nodes,listeners}=documentFor('admin');
  vm.runInNewContext(script,{document});
  const member=nodes[0].children.find(node=>node.dataset.portalEntry==='member');
  assert.equal(member,undefined);
  document.documentElement.dataset.productizedAdmin='true';listeners['productized-admin-ready']();
  assert.equal(nodes[0].children.some(node=>node.dataset.portalEntry==='member'),false);
});
test('AC-031: unknown surfaces never inject role navigation', () => {
  const { document, nodes } = documentFor('unknown');
  vm.runInNewContext(script, { document });
  assert.equal(nodes.length, 0);
});
test('RB-NAV-002: member skips the shared assets while admin and platform declarations remain', () => {
  for (const [route, surface] of [['platform/index.html','platform'],['admin/workspace.html','admin']]) {
    const page = fs.readFileSync(path.join(root,route),'utf8');
    assert.match(page, new RegExp('data-portal-surface="'+surface+'"'));
    assert.match(page, /portal-navigation\.css/);
    assert.match(page, /portal-navigation\.js/);
  }
  const member = fs.readFileSync(path.join(root, 'member/index.html'), 'utf8');
  assert.match(member, /data-portal-surface="member"/);
  assert.doesNotMatch(member, /portal-navigation\.(js|css)/, 'member page must not load the top system entry');
});

test('AC-136: nested main uses a direct body child as insertBefore reference', () => {
  const { document, nodes } = documentFor('admin');
  const directWrapper = { name: 'div' };
  const nestedMain = { name: 'main', parentElement: directWrapper };
  const children = [directWrapper];
  // Old selector returned a descendant that is not a direct child of body.
  document.body.querySelector = selector => selector === 'main' ? nestedMain : null;
  document.body.firstElementChild = directWrapper;
  document.body.insertBefore = (node, ref) => {
    assert.equal(ref, directWrapper, 'insertBefore reference must belong to body');
    children.splice(children.indexOf(ref), 0, node);
    nodes.push(node);
  };
  vm.runInNewContext(script, { document });
  assert.equal(children[0].id, 'unifiedPortalNav');
  assert.equal(children[1], directWrapper);
  assert.equal(nodes.length, 1);
});

test('RB-NAV-001: member portal never mounts the upper System Entry or User Link even if stale JS loads',()=>{
  const {document,nodes}=documentFor('member');
  vm.runInNewContext(script,{document});
  assert.equal(nodes.length,0);
  assert.equal(document.getElementById('unifiedPortalNav'),undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'member/index.html'),'utf8'),/portal-navigation\.(?:js|css)/);
});
