const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('E2E live flow visualizer shows side, module, flow and feature from start to finish', () => {
  const html = read('admin/index.html');
  const ui = read('admin/e2e-flow-visualizer.js');
  const css = read('admin/e2e-flow-visualizer.css');

  assert.match(html, /e2e-flow-visualizer\.css\?v=e2e-flow-20261006-2/);
  assert.match(html, /e2e-flow-visualizer\.js\?v=e2e-flow-20261006-1/);
  assert.match(ui, /E2E 即時流程圖/);
  for (const label of ['端別', '模組', '流程', '功能']) assert.match(ui, new RegExp(label));
  for (const stage of ['準備', '後端 QA', '管理端前置', '用戶端模組', '管理端完整', '跨端同步', '覆蓋驗證', '完成']) {
    assert.match(ui, new RegExp(stage));
  }
  assert.match(ui, /MemberAdminTestControl\?\.getStatus/);
  assert.match(ui, /MemberUserTestControl\?\.getStatus/);
  assert.match(ui, /status === 'running'/);
  assert.match(ui, /trackedWindows/);
  assert.match(css, /\.e2e-flow-rail/);
  assert.match(css, /\.e2e-flow-activity-path/);
  assert.match(css, /html\[data-theme="dark"\] \.e2e-flow-visualizer/);
  assert.match(css, /html\[data-theme="dark"\] \.e2e-flow-step\.is-running/);
  assert.match(css, /html\[data-theme="dark"\] \.e2e-flow-step\.is-passed/);
  assert.match(css, /html\[data-theme="dark"\] \.e2e-flow-step\.is-failed/);
  assert.match(css, /html\[data-theme="dark"\] \.e2e-flow-module\.is-running/);
});

test('selected modules remain observable across background runner and user child cases expose current feature', () => {
  const admin = read('admin/e2e-control.js');
  const user = read('user-test-control.js');

  assert.match(admin, /selectedModules: state\.selectedModules\.slice\(\)/);
  assert.match(admin, /currentExecution:/);
  assert.match(admin, /state\.selectedModules = normalizeSelectedModules\(snapshot\.selectedModules\)/);
  assert.match(user, /getStatus: \(\) => \{/);
  assert.match(user, /const current = \[\.\.\.state\.results\]\.reverse\(\)\.find\(\(item\) => item\?\.status === 'running'\)/);
  assert.match(user, /surface,/);
});

test('every selectable module has an execution evidence gate in the visualizer and paired E2E final coverage gate', () => {
  const ui = read('admin/e2e-flow-visualizer.js');
  const runner = read('admin/e2e-control.js');

  const evidence = {
    member: 'ADMIN_TEST_MEMBER_PROFILE_EDIT',
    points: 'ADMIN_POINT_CARD_CRUD',
    event: 'ADMIN_EVENT_TICKET_CRUD',
    calendar: 'ADMIN_CALENDAR_CRUD',
    integration: 'ADMIN_INTEGRATION_CENTER',
    booking: 'ADMIN_BOOKING_CONTROLS'
  };
  for (const [module, key] of Object.entries(evidence)) {
    assert.match(ui, new RegExp(module + ": '" + key + "'"));
    assert.match(runner, new RegExp(key));
  }
  assert.match(runner, /PAIRED_HUMAN_INTERACTION_COVERAGE/);
  assert.match(runner, /selectedModulesCovered: true/);
  assert.match(runner, /missingModules/);
});
