import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangeSet, evaluateEvidence, extractManualTier } from './pr-change-risk.mjs';

const files = (...names) => names.map((filename) => ({ filename, status: 'modified', additions: 3, deletions: 1 }));
const fullBody = `## 變更風險評估
### 需求與驗收條件
會員能完成原有預約；AC-001 驗證成功與失敗無副作用。
### 基線與目標環境
來源整合分支基線 abcdef0123456789abcdef0123456789abcdef01，目標為開發 Preview。
### 資安與資料邊界
後端驗證會員及商家歸屬，跨店讀寫拒絕且不產生資料副作用。
### 受影響模組
已盤點 booking 和 points 的前端路由，以及整合點。
### 測試與驗收
執行 node --test scripts/pr-change-risk.test.mjs，並記錄 GitHub Actions 結果。
### 回退方案
可 revert 本 PR 並重跑 CI，不觸及資料庫。
### 架構審查
獨立 workflow 只使用唯讀權限；沿用原發布閘門。
### 發布及資料庫相容性
不更動既有 Netlify 發佈來源或 Supabase migration。
### 既有功能回歸
保留原有 CI eight lanes，新增變更前後的測試證據與必要跳過阻擋。
### 程式碼品質與效能
只調整 GitHub PR 管理流程，沒有產品執行路徑，故 runtime 指標不適用；品質檢查為可維護性及 Node 測試。`;

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

test('only the canonical GitHub PR template exists and retains first-principles plus risk gates', async () => {
  const { readFile, stat } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const canonical = new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url);
  const template = await readFile(canonical, 'utf8');
  assert.match(template, /第一性原理與原功能影響/);
  for (const heading of ['變更風險評估', '受影響模組', '測試與驗收', '回退方案', '架構審查', '發布及資料庫相容性', '既有功能回歸', '程式碼品質與效能']) {
    assert.ok(template.includes(heading), `missing ${heading}`);
  }
  await assert.rejects(
    stat(fileURLToPath(new URL('../.github/pull_request_template.md', import.meta.url))),
    { code: 'ENOENT' },
  );
});

test('changes to risk enforcement or PR template are always big', () => {
  for (const filename of [
    'scripts/pr-change-risk.mjs',
    'scripts/pr-change-risk.test.mjs',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/pull_request_template.md',
  ]) {
    assert.equal(classifyChangeSet(files(filename)).level, '大改', filename);
  }
});

test('a single application or workflow code change requires regression and quality/performance explanations', () => {
  for (const path of ['MemberWebsocket-dev/booking/index.html', 'scripts/pr-change-risk.mjs', '.github/workflows/pr-change-risk.yml']) {
    const risk = classifyChangeSet(files(path));
    const empty = evaluateEvidence(risk, '');
    assert.equal(empty.passed, false, path);
    assert.ok(empty.missing.includes('既有功能回歸'), path);
    assert.ok(empty.missing.includes('程式碼品質與效能'), path);
    assert.deepEqual(evaluateEvidence(risk, fullBody).missing, [], path);
  }
});

test('quality/performance and regression evidence cannot be generic placeholders', () => {
  const risk = classifyChangeSet(files('MemberWebsocket-dev/booking/index.html'));
  const partial = fullBody.replace(/(### 既有功能回歸\n)[^\n]+/, '$1TBD')
    .replace(/(### 程式碼品質與效能\n)[^\n]+/, '$1待補');
  assert.deepEqual(evaluateEvidence(risk, partial).missing, ['既有功能回歸', '程式碼品質與效能']);
});

for (const heading of ['需求與驗收條件', '基線與目標環境', '資安與資料邊界', '測試與驗收', '回退方案']) {
  test(`readiness: even a small UI change fails without ${heading}`, () => {
    const risk = classifyChangeSet(files('MemberWebsocket-dev/booking/index.html'));
    const body = fullBody.replace(new RegExp(`### ${heading}\\n[^\\n]+\\n`), '');
    assert.deepEqual(evaluateEvidence(risk, body), { passed: false, missing: [heading] });
  });
}

test('readiness: comments, fenced examples and duplicate headings cannot provide evidence', () => {
  const risk = classifyChangeSet(files('MemberWebsocket-dev/booking/index.html'));
  const absent = fullBody.replace(/### 資安與資料邊界\n[^\n]+\n/, '');
  const section = '### 資安與資料邊界\n後端驗證商家與會員歸屬，未登入或跨店拒絕且不寫入。';
  for (const body of [
    absent + '\n<!--\n' + section + '\n-->',
    absent + '\n```markdown\n' + section + '\n```',
    absent + '\n~~~markdown\n' + section + '\n~~~',
    fullBody + '\n' + section,
    absent + '\n### 資安與資料邊界\n#### 補充\n未提供本欄的實際說明，不能從其他節借字數。',
  ]) assert.deepEqual(evaluateEvidence(risk, body), { passed: false, missing: ['資安與資料邊界'] });
});

test('review regression: headings of any level or closing hashes cannot duplicate required evidence', () => {
  const risk = classifyChangeSet(files('src/example.js'));
  for (const prefix of ['#', '##', '###', '####', '#####', '######']) {
    for (const suffix of ['', ' ##']) {
      const body = fullBody + `\n${prefix} 資安與資料邊界${suffix}\n`;
      assert.deepEqual(evaluateEvidence(risk, body), { passed: false, missing: ['資安與資料邊界'] });
    }
  }
});

test('review regression: indented code and repeated placeholder lines cannot satisfy readiness', () => {
  const risk = classifyChangeSet(files('src/example.js'));
  for (const content of ['    this is example code only', '\tthis is example code only', '待補\n待補\n待補\n待補\n待補', '- TBD\n- TBD\n- TBD\n- TBD\n- TBD']) {
    const body = fullBody.replace(/(### 資安與資料邊界\n)[^\n]+/, '$1' + content);
    assert.deepEqual(evaluateEvidence(risk, body), { passed: false, missing: ['資安與資料邊界'] });
  }
});

test('review regression: executable and configuration files under docs require readiness evidence', () => {
  for (const name of ['docs/example.js', 'docs/example.mdx', 'docs/example.sql', 'docs/example.yml', 'docs/example.json', 'docs/example.sh', 'docs/example.html']) {
    const risk = classifyChangeSet(files(name));
    assert.notEqual(risk.tier, 'L0', name);
    assert.equal(evaluateEvidence(risk, '').passed, false, name);
  }
  assert.equal(evaluateEvidence(classifyChangeSet(files('docs/example.md')), '').passed, true);
});

test('readiness CLI returns failure for missing security evidence and success for a complete plan', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pr-readiness-'));
  try {
    await writeFile(join(dir, 'files.json'), JSON.stringify(files('MemberWebsocket-dev/booking/index.html')));
    for (const [body, code] of [[fullBody, 0], [fullBody.replace(/### 資安與資料邊界\n[^\n]+\n/, ''), 1]]) {
      await writeFile(join(dir, 'body.md'), body);
      const result = spawnSync(process.execPath, ['scripts/pr-change-risk.mjs', '--files-json', join(dir, 'files.json'), '--body-file', join(dir, 'body.md')], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
      assert.equal(result.status, code, result.stdout + result.stderr);
      if (code) assert.match(result.stderr, /資安與資料邊界/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('non-code documentation does not require artificial runtime benchmark evidence', () => {
  const risk = classifyChangeSet(files('docs/superpowers/specs/feature.md', 'README.md'));
  assert.equal(evaluateEvidence(risk, '').passed, true);
});

test('canonical PR template asks reviewers to avoid speculative abstraction', async () => {
  const { readFile } = await import('node:fs/promises');
  const template = await readFile(new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  assert.match(template, /避免過度設計/);
  assert.match(template, /已評估最小方案/);
  assert.match(template, /不為假想需求/);
});

test('V2 tiers distinguish documentation, UI, cross-module and sensitive paths', () => {
  assert.equal(classifyChangeSet(files('docs/guide.md')).tier, 'L0');
  assert.equal(classifyChangeSet(files('MemberWebsocket-dev/booking/index.html')).tier, 'L1');
  assert.equal(classifyChangeSet(files('MemberWebsocket-dev/booking/app.js', 'MemberWebsocket-dev/points/app.js')).tier, 'L2');
  for (const name of ['AGENTS.md', 'docs/DEVELOPMENT_GUARDRAILS.md', 'MemberWebsocket-dev/admin/business-line-settings.js', 'MemberWebsocket-dev/admin/business-workspace.js', 'netlify.toml']) {
    assert.equal(classifyChangeSet(files(name)).tier, 'L3', name);
  }
});
test('risk override may increase but cannot decrease classification', () => {
  assert.equal(classifyChangeSet(files('MemberWebsocket-dev/booking/index.html'), { manualTier: 'L3' }).tier, 'L3');
  assert.equal(classifyChangeSet(files('netlify.toml'), { manualTier: 'L0' }).tier, 'L3');
  assert.throws(() => classifyChangeSet(files('README.md'), { manualTier: 'L9' }), /Invalid manual risk tier/);
});
test('renaming a sensitive merchant file remains high risk', () => {
  assert.equal(classifyChangeSet([{ filename: 'docs/moved.md', previous_filename: 'MemberWebsocket-dev/admin/business-line-settings.js', status: 'renamed' }]).tier, 'L3');
});

test('PR body opt-in escalation parser accepts an exact tier token and ignores prose', () => {
  assert.equal(extractManualTier('### 風險等級覆核\nL3 — 重大授權變更'), 'L3');
  assert.equal(extractManualTier('## 摘要\n### 風險等級覆核（選填）\nL2: 多模組'), 'L2');
  assert.equal(extractManualTier('### 風險等級覆核\n自動判斷為 L3'), undefined);
  assert.equal(extractManualTier('### 風險等級覆核\nL9'), undefined);
  assert.equal(extractManualTier('### 風險等級覆核\nTBD'), undefined);
});

test('canonical PR template exposes optional manual risk escalation without lowering the floor', async () => {
  const { readFile } = await import('node:fs/promises');
  const template = await readFile(new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  assert.match(template, /^### 風險等級覆核（選填）$/m);
  assert.match(template, /不可降低自動分級/);
  assert.equal(extractManualTier(template), undefined);
  assert.equal(
    classifyChangeSet(files('netlify.toml'), { manualTier: extractManualTier(template) }).tier,
    'L3',
  );
});

test('governance documents must never be classified L0', () => {
  for (const filename of [
    'docs/AGILE_DEVELOPMENT.md',
    'scripts/governance-workflow.test.mjs',
    'scripts/netlify-publish-workflow.test.mjs',
  ]) {
    const risk = classifyChangeSet(files(filename));
    assert.equal(risk.tier, 'L3', filename);
    assert.equal(risk.requiresQualityEvidence, true, filename);
    assert.equal(evaluateEvidence(risk, '').passed, false, filename);
  }
});
