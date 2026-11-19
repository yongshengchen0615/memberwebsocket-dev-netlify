# 品質、架構、效能與舊功能保護 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓每次變更都有具體品質、架構、效能及回歸判斷，補上既有測試漏跑與發布工具風險誤判。

**Architecture:** 沿用三條既有完整 CI，不重建測試框架。增加靜態測試接線檢查、補入兩份既有測試、擴充現有 PR 證據及發布路徑分級。

**Tech Stack:** Node.js 24 原生 test runner、既有 Node.js 22 PGlite 整合測試、GitHub Actions。

**Spec:** 本文件「範圍與驗收」記錄本輪使用者要求與已查證缺口。

## Global Constraints

- 基準 `a813e7d6f7df1eace23a334878d0c6a39b068163`；來源／目標 `Integrated-Marketing-Platform`。
- 不新增依賴、產品執行碼、SQL migration、計時器或正式環境設定變更。
- 只驗靜態接線，不將清單存在、文字欄位或獨立審查當作測試已成功。
- 最終交付需同 SHA 完整既有 CI；缺少任何必要結果時保留受阻狀態。

## 範圍與驗收

已確認：`booking-transport.test.mjs` 與 `e2e_runtime_recycle_sql.cjs` 沒有接入任一 workflow；發布工具包含 `supabase-release.mjs` 被判 L1；小型程式變更目前無強制架構欄位。

| AC | Given / When / Then | 案例與證據 |
|---|---|---|
| AC-001 | Given script／SQL／DOM 測試，When 掃描 CI，Then 未接線測試使清單檢查失敗 | ci-test-inventory；RED 日誌先列出兩份舊測試與本檢查自身，接入後 GREEN |
| AC-002 | Given inline／block／folded run，When 讀取 Node 指令，Then 只辨識實際命令，忽略 comment／echo／step name | ci-test-inventory parser 正負向案例 |
| AC-003 | Given 程式／設定／治理變更，When 缺少架構影響說明，Then PR 證據檢查失敗；純說明文件維持輕量 | pr-change-risk 正常／placeholder／隱藏註解／文件案例 |
| AC-004 | Given 發布實作／測試或重新命名，When 分級，Then 維持 L3 並要求發布及資料庫相容性 | pr-change-risk 發布路徑與 rename 案例 |

方案比較：僅加文件不能偵測漏跑；全面改寫 runner／架構超出本輪需要。採現有 workflow 小修與靜態 inventory，保留全部原測試及發布流程。

## Review Focus

- 清單新增未接入的測試必須失敗，包括 inventory 自己。
- helper 排除只列實際共用工具，過期排除與具名 test 宣告不得通過。
- Node 指令旁的註解、echo、step name 不得滿足接線。
- 小型變更仍要架構影響，但不強迫新增抽象；純文件保持既有豁免。
- 發布路徑的實作、測試、刪除或搬移都不能降為低風險。

## Task 1：補測試接線

**Files:** `scripts/ci-test-inventory.test.mjs`、兩份 test workflow。

**Interfaces:** 消費既有 workflow run 指令與兩層整合目錄，產出原生 Node 測試結果；四個具名 helper 有用途排除。

- [x] 增加清單檢查與命令解析正負向案例，實跑 RED，確認兩份舊案例漏跑。
- [x] 將通知排程恢復測試接 static-site，租約回收 SQL 接 extended 整合 lane，inventory 接 static-site。
- [ ] 驗證 GREEN、全專案完整 CI 與獨立審查。

## Task 2：每輪架構證據及發布風險

**Files:** `scripts/pr-change-risk.mjs`／測試、`AGENTS.md`、`docs/DEVELOPMENT_GUARDRAILS.md`、PR template。

**Interfaces:** 沿用 `classifyChangeSet`／`evaluateEvidence`，僅擴充已知發布路徑及品質欄位，不新增 Gate 服務。

- [x] 增加小型變更缺架構欄位與發布路徑誤判 RED 案例。
- [x] 將架構欄位加入全體程式／設定／治理變更要求；發布工具及測試維持 L3，rename 沿用原路徑。
- [x] 規範說明每次評估與實際局部改善，保留最小充分設計、相容及效能實測要求。
- [ ] 驗證所有必要 CI；記錄最終 SHA、案例統計及回復方法。

## 執行與回復

開發測試：`node --test scripts/pr-change-risk.test.mjs scripts/ci-test-inventory.test.mjs scripts/governance-workflow.test.mjs scripts/runtime-quality.test.mjs scripts/booking-transport.test.mjs`。

完整驗證：PR 執行 `test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`，包含 PostgreSQL、DOM、Chromium、Edge 型別與測試、audit、建置及 aggregate。

環境備註：本沙盒 `/tmp` 不可寫，測試時指定 `TMPDIR=/workspace/scratch/d7a61d811c2b/tmp`；第一次未指定時 7 個 fixture 建立失敗，屬環境問題，並未修改斷言以通過。

回復：revert 本 PR 的程式與規範提交並重跑 CI；無資料庫或產品資料變更。只改 CI／治理，不影響頁面／API runtime，效能 benchmark 不適用，不宣稱提速。
