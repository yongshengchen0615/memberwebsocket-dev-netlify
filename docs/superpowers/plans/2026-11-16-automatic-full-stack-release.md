# Automatic full stack release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓兩個發布分支在同 SHA CI 後依序部署 SQL、Edge、前端。
**Architecture:** 保留現有發布 workflow；凍結無法共用的舊 migration 歷史，新 SQL 使用交易式 checksum ledger；測試原生前端新增後端完成 gate。
**Tech Stack:** Node 24、PostgreSQL、Supabase Management API、固定 Supabase CLI、GitHub Actions、Netlify。
**Spec:** docs/superpowers/specs/2026-11-16-automatic-full-stack-release-design.md

## Global Constraints

- master → dbuquirnaskrwcamdxki；Integrated-Marketing-Platform → bmwhojszsnxliekkhrka。
- 僅新 migration（大於 20261111134000）；凍結歷史 hashes；不搬資料/秘密。
- 舊前端相容；任何必要 gate 失敗停止；不 blanket deploy、不部署退休/preview/reset。
- 保留既有完整三條 CI；本輪新增 PostgreSQL/失敗/併發測試納入基線。

## Review Focus

1. SQL 中的字串、註解與函式 body 不應被誤判交易控制。
2. 上次部署結果不明或 Edge 部分成功時不能發布新前端。
3. 原生測試建置不能只通過舊 CI 就提前發布。
4. 已套用 migration 被刪除、改名、改內容均應拒絕。
5. GitHub Actions 缺少權杖與外部驗收不可計為通過。

### Task 1: 遷移與目標規劃
Files: scripts/supabase-release.mjs、scripts/supabase-release.test.mjs、MemberWebsocket-dev/supabase/deployment-baseline.json。
Interface: releaseTarget(branch)、loadReleasePlan(root)、migrationSQL(plan,sha)、deployBackend(options)。
- [ ] 寫 AC-001/002/006/008 失敗測試，執行 `node --test scripts/supabase-release.test.mjs`，預期缺少模組失敗。
- [ ] 實作固定目標、歷史 hash、交易 SQL、API 與明列 Edge 發布。
- [ ] 重跑 unit，預期無失敗/skip，提交。

### Task 2: 真資料庫驗收
Files: MemberWebsocket-dev/tests/integration/postgres/deployment-release.cjs、test-memberwebsocket-dev.yml。
Interface: 使用既有隔離 database.cjs；呼叫 Task 1 migrationSQL。
- [ ] 寫 AC-003–005 PostgreSQL 實際結果斷言：新建/升級、重跑、失敗 rollback、checksum/刪檔拒絕、兩連線併發與回復。
- [ ] 納入既有 PostgreSQL job；本機可用 PGlite 驗證 SQL，真併發仍以 CI PostgreSQL 為準。
- [ ] 執行新測試及完整基線，記錄實際數量與受阻。

### Task 3: 串接發布順序
Files: publish-netlify.yml、publish-platform-preview.yml、netlify-native-ci-gate.mjs/tests、test-netlify-build.yml、README.md。
- [ ] 寫 AC-007 與 workflow 順序失敗測試。
- [ ] 同 SHA CI 後部署 backend，成功才寫測試後端標記，之後沿用前端發布；部署前核對分支 HEAD。
- [ ] 保留後端 evidence artifact，憑證缺失前置失敗；取消舊部署不能中斷已開始的後端寫入。
- [ ] 文件列出秘密來源、流程、首次啟用邊界、migration 規則與回復。
- [ ] 最終完整基線、審查、兩個隔離 PR；若必要 secrets 不可取得，明確交付阻礙與可執行下一步。

### Task 4: GitHub push 事件遺失的完整恢復
Files: 三個 test workflow 加 workflow_call；兩個 publish workflow 加手動 recovery baseline jobs；scripts/release-recovery.mjs/tests；既有 workflow 合約測試與 README。
Interface: requireRecoveryBaselines({event,ref,sha,needs})，三個明確結果均 success、合法發布 ref 與 exact SHA 才通過；CLI 消費 GitHub needs JSON。
- [ ] 先寫正常/失敗/取消/skip/缺失/錯誤 ref 與 SHA 的 RED 測試。
- [ ] 加入不帶 secrets、相同 commit 的三條 reusable 完整基線；手動才用此 gate，push 保留原 gate。
- [ ] 調整既有文字合約以保留 master-only、取消拒絕和同 SHA 意義；不改測試基線命令、案例或 timeout。
- [ ] 完整 CI 與獨立審查後合併測試；從 Actions UI 選測試分支執行恢復，驗證實際 SQL/Edge/Netlify。
- [ ] 相同修正套到正式 PR，測試驗收成功後合併與驗證正式發布。

### Task 5 — 發布標記寫後讀回

1. 保留真實失敗 run 43905366583、唯讀診斷 43908860262，根因為標記未保存。
2. 先建立成功但未保存的失敗測試，再實作固定網站／分支、builds scope 的官方 API 寫入與讀回；不重試不明寫入。
3. 接回原 SQL/Edge → 後端標記 → CI 標記 → 原生建置序列；更新原有流程斷言，加入持久化行為測試。
4. 最終 SHA 執行全部 CI，真實測試發布成功後才合併正式 PR；不宣稱 runtime 提速，此變更只影響部署控制。

### Task 6 — 相容現有 Netlify 方案

1. 保存44011300383的403與44012509631診斷，先以相同403契約建立AC-016 RED。
2. 建立只含公開SHA、唯一測試分支context的標記時省略付費scope選項，讀回僅接受標準預設scope或既有builds-only。
3. 保留所有CI、後端、HEAD、來源、分支與讀回檢查；用負向測試確認預設scope不能繞過production/all context限制。
4. 完整CI與實際發布成功後才合併正式版；不新增付費承諾，無產品runtime效能變更。

### Task 7 — 保留原 Git 分支大小寫

1. 以44015170184原生錯誤與44015475946同SHA控制實驗定位context消費差異。
2. AC-017先重現saved-but-not-consumable，再只改context_parameter為已驗證原Gitbranch，保留所有負向與安全檢查。
3. 既有兩個公開標記已轉為唯一正確context，不新增不必要相容邏輯。
4. 最終SHA完整CI與合併自動發布成功後才正式合併，保留Native/alias/production身分與smoke證據。
