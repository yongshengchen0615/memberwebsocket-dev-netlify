const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../admin/e2e-control.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/test-control-api/index.ts'), 'utf8');
const exposed = source.replace(/\}\)\(\);\s*$/, `globalThis.e2ePlan = {
  state, E2E_MODULES, ADMIN_CASE_MODULES, MODULE_HUMAN_EVIDENCE,
  normalizeSelectedModules, selectedModulesFromUi, selectedClientSurfaces,
  weightedSurfacePlan, adminDefinitions, configureRandom, startUnifiedBackgroundE2E
};})();`);
assert.notEqual(exposed, source);

function plan() {
  const context = { window: { addEventListener() {} }, document: {}, console };
  vm.runInNewContext(exposed, context);
  return context.e2ePlan;
}

function backendPlan() {
  const modulesStart = serverSource.indexOf('const E2E_MODULE_KEYS =');
  const replayStart = serverSource.indexOf('\nconst REPLAY_SURFACES =', modulesStart);
  const casesStart = serverSource.indexOf('function caseDefinitions(', replayStart);
  const runClientStart = serverSource.indexOf('\nfunction runClient(', casesStart);
  assert.ok(modulesStart >= 0 && replayStart > modulesStart && casesStart > replayStart && runClientStart > casesStart);
  const executable = (serverSource.slice(modulesStart, replayStart) + '\n' + serverSource.slice(casesStart, runClientStart))
    .replace(' as const;', ';')
    .replace('value: unknown): string[] | null', 'value)')
    .replace('key as typeof E2E_MODULE_KEYS[number]', 'key')
    .replace('suite: string, selectedModules: string[] | null = null): Array<{ key: string; name: string; domain: string }>', 'suite, selectedModules = null)')
    .replace('const owners: Record<string, string[]>', 'const owners');
  const context = { ApiError: class extends Error { constructor(status, code, message) { super(message); this.code = code; } } };
  vm.runInNewContext(executable + '\nglobalThis.backendPlan = { selectedE2EModules, caseDefinitions };', context);
  return context.backendPlan;
}

test('six selectable scopes reject empty or unknown selections and preserve a stable order', () => {
  const e2e = plan();
  const keys = Array.from(e2e.E2E_MODULES, ([key]) => key);
  assert.deepEqual(keys, ['member', 'points', 'event', 'calendar', 'integration', 'booking']);
  assert.throws(() => e2e.normalizeSelectedModules([]), /至少勾選/);
  assert.throws(() => e2e.normalizeSelectedModules(['member', 'unknown']), /有效的 E2E 模組/);
  assert.deepEqual(Array.from(e2e.normalizeSelectedModules(['booking', 'member', 'booking'])), ['member', 'booking']);
  e2e.state.section = { querySelectorAll: () => [
    { dataset: { e2eModule: 'booking' } }, { dataset: { e2eModule: 'member' } }
  ] };
  assert.deepEqual(Array.from(e2e.selectedModulesFromUi()), ['member', 'booking']);
});

test('each scope runs its own admin UI cases and only the selected user surfaces', () => {
  const e2e = plan();
  const modules = Array.from(e2e.E2E_MODULES, ([key]) => key);
  for (let mask = 1; mask < (1 << modules.length); mask += 1) {
    const selected = modules.filter((_, index) => mask & (1 << index));
    const clientSurfaces = Array.from(e2e.selectedClientSurfaces(selected), ([key]) => key);
    assert.deepEqual(clientSurfaces, selected.filter((key) => key !== 'integration'));
    e2e.configureRandom('scope-' + mask);
    const planned = Array.from(e2e.weightedSurfacePlan({}, 1, selected), ([key]) => key);
    assert.deepEqual(planned.slice().sort(), clientSurfaces.slice().sort());

    const caseKeys = new Set(Array.from(e2e.adminDefinitions('full', selected), ({ key }) => key));
    assert.ok(caseKeys.has('ADMIN_AUTH_READY'));
    assert.ok(caseKeys.has('ADMIN_PRIMARY_NAVIGATION'));
    for (const module of modules) {
      const evidenceKey = e2e.MODULE_HUMAN_EVIDENCE[module];
      assert.equal(caseKeys.has(evidenceKey), selected.includes(module), `${mask}: ${evidenceKey}`);
    }
    for (const [key, owners] of Object.entries(e2e.ADMIN_CASE_MODULES)) {
      assert.equal(caseKeys.has(key), owners.some((owner) => selected.includes(owner)), `${mask}: ${key}`);
    }
    assert.equal(caseKeys.has('ADMIN_BUTTON_COVERAGE'), selected.length === modules.length);
  }
});

test('background handoff freezes the checked scope and avoids client windows for integration only', async () => {
  for (const selected of [['integration'], ['points', 'booking']]) {
    let forwarded;
    let clientWindowCount = 0;
    const runner = {
      closed: false, blur() {},
      document: { getElementById: () => null, documentElement: { dataset: { memberAdminReady: 'true' } } },
      MemberAdminE2EControl: { version: source.match(/const VERSION = '([^']+)'/)[1], runUnifiedBackground: async (options) => { forwarded = options; return { results: [] }; } }
    };
    const window = {
      location: { href: 'https://example.test/MemberWebsocket-dev/admin/', search: '' },
      addEventListener() {}, focus() {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      open(url) {
        if (url !== 'about:blank') return runner;
        clientWindowCount += 1;
        return { closed: false, document: { body: {} }, blur() {}, close() {} };
      }
    };
    const context = { window, document: {}, URL, URLSearchParams, console, Math, performance: { getEntriesByType: () => [] } };
    vm.runInNewContext(exposed, context);
    const e2e = context.e2ePlan;
    const inputs = selected.map((key) => ({ dataset: { e2eModule: key }, disabled: false }));
    e2e.state.section = {
      querySelector: (selector) => selector === '#pairedE2EAccountCount' ? { value: '2' } : null,
      querySelectorAll: (selector) => selector === '[data-e2e-module]:checked' ? inputs : []
    };
    const start = e2e.startUnifiedBackgroundE2E();
    assert.equal(start.started, true);
    await start.completion;
    assert.deepEqual(Array.from(forwarded.selectedModules), selected);
    assert.equal(clientWindowCount, selected.includes('integration') && selected.length === 1 ? 0 : 2);
  }
});

test('backend QA accepts the chosen modules and keeps shared safety checks', () => {
  const backend = backendPlan();
  assert.throws(() => backend.selectedE2EModules([]), /至少勾選/);
  assert.throws(() => backend.selectedE2EModules(['integration', 'unknown']), /有效的 E2E 模組/);
  const allCases = Array.from(backend.caseDefinitions('full'), ({ key }) => key);
  assert.equal(allCases.length, 10);
  const shared = ['ENVIRONMENT_ACCESS', 'TEST_ACCOUNT_INTEGRITY', 'SESSION_SECURITY', 'LINE_SUPPRESSION'];
  const owned = {
    POINTS_INTEGRITY: ['points'], FIXED_TICKET_INTEGRITY: ['points', 'event'],
    MEMBERSHIP_TERMS_READY: ['member'], BOOKING_INTEGRITY: ['booking'], BOOKING_CONFIRMATION_LINE: ['booking'], PRESENCE_INTEGRITY: ['member']
  };
  const modules = ['member', 'points', 'event', 'calendar', 'integration', 'booking'];
  for (let mask = 1; mask < (1 << modules.length); mask += 1) {
    const selected = modules.filter((_, index) => mask & (1 << index));
    const accepted = backend.selectedE2EModules(selected.slice().reverse());
    assert.deepEqual(Array.from(accepted), selected);
    const keys = Array.from(backend.caseDefinitions('full', accepted), ({ key }) => key);
    for (const key of shared) assert.ok(keys.includes(key), `${mask}: ${key}`);
    for (const [key, owners] of Object.entries(owned)) {
      assert.equal(keys.includes(key), owners.some((owner) => selected.includes(owner)), `${mask}: ${key}`);
    }
  }
});
