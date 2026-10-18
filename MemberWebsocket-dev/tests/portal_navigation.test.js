const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'portal-navigation.js'), 'utf8');
function documentFor(surface) {
  const nodes = [];
  const createElement = name => ({
    name, attributes: {}, children: [], className: '', textContent: '', href: '',
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
  };
  return { document, nodes };
}
test('AC-030: independent entrances use one accessible navigation and exactly one active role', () => {
  for (const surface of ['platform', 'admin', 'member']) {
    const { document, nodes } = documentFor(surface);
    vm.runInNewContext(script, { document });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].attributes['aria-label'].includes('獨立驗證'), true);
    const links = nodes[0].children.filter(item => item.name === 'a');
    assert.deepEqual(links.map(item => item.href), ['/platform/', '/admin/', '/member/']);
    assert.equal(links.filter(item => item.attributes['aria-current'] === 'page').length, 1);
    assert.equal(links.find(item => item.attributes['aria-current'] === 'page').href,
      { platform:'/platform/', admin:'/admin/', member:'/member/' }[surface]);
    vm.runInNewContext(script, { document });
    assert.equal(nodes.length, 1, 'navigation is not duplicated');
  }
});
test('AC-031: unknown surfaces never inject role navigation', () => {
  const { document, nodes } = documentFor('unknown');
  vm.runInNewContext(script, { document });
  assert.equal(nodes.length, 0);
});
test('AC-032: each portal actually imports the shared CSS and JS with explicit role', () => {
  for (const [route, surface] of [['platform/index.html','platform'],['admin/workspace.html','admin'],['member/index.html','member']]) {
    const page = fs.readFileSync(path.join(root,route),'utf8');
    assert.match(page, new RegExp('data-portal-surface="'+surface+'"'));
    assert.match(page, /portal-navigation\.css/);
    assert.match(page, /portal-navigation\.js/);
  }
});
