const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../member-system.js'), 'utf8');
const begin = source.indexOf('  function assertLegacyTenantScope() {');
const end = source.indexOf('  async function loadConfig()', begin);
test('AC-034: tenant-scoped URLs never fall back to legacy single-merchant API', () => {
  assert.ok(begin > 0 && end > begin, 'explicit guard exists');
  const fragment = source.slice(begin, end);
  for (const query of ['', '?feature=booking', '?tenant=', '?tenant=other-shop', '?tenant=admin']) {
    const context = {
      window: { location: { search: query } }, URLSearchParams,
      clientError(code, message) { return Object.assign(new Error(message), { code }); },
    };
    const guarded = vm.runInNewContext(fragment + '\nassertLegacyTenantScope', context);
    if (query.includes('tenant=')) {
      assert.throws(() => guarded(), err => err.code === 'TENANT_NOT_READY');
    } else assert.doesNotThrow(() => guarded());
  }
});
test('AC-035: guard executes before both configuration load and API dispatch', () => {
  assert.match(source, /async function loadConfig\(\) \{\s*assertLegacyTenantScope\(\);/);
  assert.match(source, /async function sendRequest\(config, clientType, idToken, action, payload\) \{\s*assertLegacyTenantScope\(\);/);
});
