import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const guardrails = readFileSync(new URL('../docs/DEVELOPMENT_GUARDRAILS.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/test-memberwebsocket-dev.yml', import.meta.url), 'utf8');
const expectedLanes = [
  'regression', 'integration', 'postgres-integration', 'browser-e2e',
  'browser-syntax', 'edge-functions', 'wiring', 'dependency-audit',
];

test('every pull request triggers the entire regression workflow, regardless of changed paths', () => {
  const topLevel = workflow.split(/^permissions:/m)[0];
  const marker = '  pull_request:\n';
  const index = topLevel.indexOf(marker);
  assert.notEqual(index, -1, 'pull_request event is required');
  const prSettings = topLevel.slice(index + marker.length);
  assert.doesNotMatch(prSettings, /^\s+(?:paths|paths-ignore|branches|branches-ignore):/m);
});

test('all eight test lanes and the aggregate validation job remain present', () => {
  const jobs = workflow.split(/^jobs:\s*$/m)[1];
  assert.ok(jobs, 'jobs block is required');
  for (const name of [...expectedLanes, 'validate']) {
    assert.ok(new RegExp('^  ' + name + ':', 'm').test(jobs), name + ' must exist');
  }
  const aggregate = jobs.split(/^  validate:\s*$/m)[1];
  assert.ok(aggregate, 'aggregate validation must exist');
  assert.match(aggregate, /^    if: always\(\)/m);
  const needs = aggregate.match(/^    needs: \[([^\]]+)\]/m);
  assert.ok(needs, 'aggregate needs dependencies');
  assert.deepEqual(
    new Set(needs[1].split(',').map((name) => name.trim())),
    new Set(expectedLanes),
  );
  for (const variable of [
    'REGRESSION', 'INTEGRATION', 'POSTGRES_INTEGRATION', 'BROWSER_E2E',
    'BROWSER_SYNTAX', 'EDGE_FUNCTIONS', 'WIRING', 'DEPENDENCY_AUDIT',
  ]) {
    assert.ok(aggregate.includes('test "$' + variable + '" = success'), variable + ' must be required to pass');
  }
});

test('project status vocabulary stays synchronized with the current nine-stage board', () => {
  const required = [
    '待規劃', '準備開始', '開發中', '程式碼審查', 'QA / E2E',
    '等待部署', '觀察中', '已完成', '已阻塞',
  ];
  for (const name of required) {
    assert.ok(guardrails.includes(name), `missing Project status: ${name}`);
  }
  assert.ok(guardrails.includes('不能把英文舊名稱當成可寫入的欄位值'));
  assert.doesNotMatch(agents, /\*\*目前已知阻擋\*\*.*Chromium/);
});

test('perpetual development rules require code quality and reproducible before/after performance evidence', () => {
  assert.match(agents, /程式碼品質檢查/);
  assert.match(agents, /效能前後比較/);
  assert.match(guardrails, /程式碼品質與效能/);
  assert.match(guardrails, /基準 SHA/);
  assert.match(guardrails, /同一量測條件/);
  assert.match(guardrails, /沒有實測不得宣稱效能提升/);
  assert.match(guardrails, /既有功能回歸/);
});

test('YAGNI: development guidance and PR template prohibit unnecessary complexity', () => {
  const template = readFileSync(new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  assert.match(agents, /避免過度設計/);
  assert.match(agents, /不為假想需求/);
  assert.match(guardrails, /YAGNI/);
  assert.match(guardrails, /先選最小可驗證方案/);
  assert.match(guardrails, /AC-015/);
  assert.match(template, /避免過度設計/);
  assert.match(template, /已評估最小方案/);
});

test('V2 R01-R10 daily rules are present and preserve security and evidence requirements', () => {
  const ids = ["R01","R02","R03","R04","R05","R06","R07","R08","R09","R10"];
  for (const id of ids) assert.match(agents, new RegExp('\\*\\*' + id + '｜'));
  for (const text of ['後端授權', 'RLS', '完整產品 CI', 'Required Checks']) {
    assert.ok(agents.includes(text), text);
  }
  assert.match(guardrails, /R01–R10/);
});


test('Scrumban rules preserve DoR, DoD, nine statuses and deployment gates', () => {
  const agile = readFileSync(new URL('../docs/AGILE_DEVELOPMENT.md', import.meta.url), 'utf8');
  assert.ok(agents.includes('## 六、敏捷式開發（Scrumban）'));
  assert.ok(agents.includes('docs/AGILE_DEVELOPMENT.md'));
  assert.ok(guardrails.includes('## 9. 敏捷迭代配套（Scrumban）'));
  for (const key of [
    'Sprint Goal', 'Backlog Refinement', 'Sprint Planning', 'Daily async',
    'Sprint Review', 'Retrospective', 'Definition of Ready（DoR）',
    'Definition of Done（DoD）', 'WIP 上限', 'P0 緊急插單規則',
    'Carryover', 'Lead Time', 'Cycle Time', 'Blocked Aging',
    '不能把文件建議寫成已存在的 GitHub 欄位',
    '僅合併 PR 不等於發布或 Done', '不得因 Sprint 結束就標完成',
  ]) assert.ok(agile.includes(key), key);
  for (const state of [
    '待規劃', '準備開始', '開發中', '程式碼審查', 'QA / E2E',
    '等待部署', '觀察中', '已完成', '已阻塞',
  ]) assert.ok(agile.includes(state), 'Missing status ' + state);
});
