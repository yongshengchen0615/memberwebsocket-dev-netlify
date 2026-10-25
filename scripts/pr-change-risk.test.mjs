import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangeSet, evaluateEvidence } from './pr-change-risk.mjs';

const files = (...names) => names.map((filename) => ({ filename, status: 'modified', additions: 3, deletions: 1 }));
const fullBody = `## 變更風險評估
### 受影響模組
已盤點 booking 和 points 的前端路由，以及整合點。
### 測試與驗收
執行 node --test scripts/pr-change-risk.test.mjs，並記錄 GitHub Actions 結果。
### 回退方案
可 revert 本 PR 並重跑 CI，不觸及資料庫。
### 架構審查
獨立 workflow 只使用唯讀權限；沿用原發布閘門。
### 發布及資料庫相容性
不更動既有 Netlify 發佈來源或 Supabase migration。`;

test('empty or invalid GitHub file list fails closed', () => {
  assert.throws(() => classifyChangeSet([]), /non-empty/);
  assert.throws(() => classifyChangeSet([{ filename: '' }]), /Invalid/);
});
test('docs-only change is small, no mandatory impact fields', () => {
  const r = classifyChangeSet(files('docs/guide.md', 'README.md'));
  assert.equal(r.level, '小改');
  assert.equal(r.score, 0);
  assert.equal(evaluateEvidence(r, '').passed, true);
});
test('single booking UI page is small', () => {
  assert.equal(classifyChangeSet(files('MemberWebsocket-dev/booking/index.html')).level, '小改');
});
test('two independent modules are medium', () => {
  const r = classifyChangeSet(files('MemberWebsocket-dev/booking/booking.js', 'MemberWebsocket-dev/points/points.js'));
  assert.equal(r.level, '中改');
  assert.equal(r.modules.length, 2);
  assert.equal(evaluateEvidence(r, '').passed, false);
  assert.deepEqual(evaluateEvidence(r, fullBody).missing, []);
});
test('three modules is a big cross-module change', () => {
  const r = classifyChangeSet(files('MemberWebsocket-dev/admin/app.js', 'MemberWebsocket-dev/member/app.js', 'MemberWebsocket-dev/booking/app.js'));
  assert.equal(r.level, '大改');
});
test('single migration, edge function, authorization or deployment workflow is big', () => {
  for (const filename of ['MemberWebsocket-dev/supabase/migrations/20261025000000_change.sql', 'supabase/functions/api/index.ts', 'MemberWebsocket-dev/admin/admin-session.js', '.github/workflows/publish-netlify.yml', 'netlify.toml']) {
    assert.equal(classifyChangeSet(files(filename)).level, '大改', filename);
  }
});
test('renamed/deleted sensitive path remains big', () => {
  const r = classifyChangeSet([{ filename: 'docs/old-migration.sql', previous_filename: 'supabase/migrations/123_unsafe.sql', status: 'renamed' }]);
  assert.equal(r.level, '大改');
});
test('reject placeholders and missing large-change review', () => {
  const r = classifyChangeSet(files('.github/workflows/pr-change-risk.yml'));
  const partial = `## 變更風險評估
### 受影響模組
已盤點部署工作流程。
### 測試與驗收
待補
### 回退方案
TBD`;
  const x = evaluateEvidence(r, partial);
  assert.equal(x.passed, false);
  assert.ok(x.missing.includes('測試與驗收'));
  assert.ok(x.missing.includes('回退方案'));
  assert.ok(x.missing.includes('架構審查'));
  assert.ok(x.missing.includes('發布及資料庫相容性'));
  assert.deepEqual(evaluateEvidence(r, fullBody).missing, []);
});
test('shared code increases risk but not an automatic large change', () => {
  assert.equal(classifyChangeSet(files('MemberWebsocket-dev/shared/api.js')).level, '中改');
});
