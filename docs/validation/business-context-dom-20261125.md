# 商家入口品質與效能驗證

## 本輪結果

此文件記錄候選版本的實作與本機驗收；完整交付狀態以最終 SHA 的 PR Checks 與發布證據為準。完整 CI 未成功前不合併／部署，不以本機部分成功替代完整驗收。

基準 `81de73c5b4f8772449649967f02a06f6a5abcfd5`，來源／目標 `Integrated-Marketing-Platform`，工作分支 `perf/business-context-dom-20261125`。測試環境 MemberWebsocket-test；沒有正式環境、DB、Edge、LINE 或秘密設定寫入。

## 第一性原理摘要與變更

已確認：共用商家模組每次 childList 變動會掃描整頁；同一 HTTP 結果的多個消費端仍重複掃描。商家切換未立即更新已存在的導航。採用 root-scoped gate/retain 與冪等 DOM 寫入，完整權限／商家改變仍處理整頁；新增節點與後代一起處理，重疊及已移除根不再重複處理。不新增框架、timer、套件、資料模型、快取或認證協定。

不變條件：未授權功能預設拒絕；all/any、benefit、dialog 與導航規則順序保留；切換商家先關閉原權限，舊 HTTP 回應仍依原世代檢查拒絕；相同進行中讀取共用 Promise，但不同 key/商家/LINE feature 不共用。伺服器仍獨立授權，不把 UI gate 當作安全邊界。

影響：`business-context.js` → 會員卡、集點卡、活動票券、日曆、預約及管理端商家導航。僅更新共用 DOM 同步，不更動業務 API 與交易。CI 增加一個 JSDOM 檔並擴充其既定命令清單；人工旅程 inventory 保留原 62 組案例，新增審查說明與新來源雜湊。

## 驗收對照

| AC | 測試與結果 |
|---|---|
| AC-001 | JSDOM：1,000 既存連結、100 批文字更新，整頁查詢及既存連結改寫均為 0；通過 |
| AC-002 | 動態根／巢狀功能、all/any、benefit、dialog、外部／商家切換／workspace 連結；JSDOM 與 390/1280px Chromium 通過 |
| AC-003 | 撤權／復權、商家切換與舊 config 隔離；JSDOM、既有 routing/connection suites 通過 |
| AC-004 | 100 相同 startup 共用一個 HTTP；未變更 refresh 仍發一個權威讀取，無品牌 DOM mutation；通過 |
| AC-005 | 重疊根只處理一次，移除節點不改寫，observer 收斂；通過 |
| AC-006 | 完整同 SHA CI、PostgreSQL、Edge 與全量 Chromium：結果以本 PR 對應 Actions 為準，未完成不能算通過 |

## 已實際執行的測試

本機 Node v24.22.3、Linux、JSDOM 26.1.0、Playwright 1.56.1；2026-11-25 台灣時間。原始診斷日誌在本次工作環境，完整遠端日誌由 Actions 保存。

| 檢查 | 命令／工具 | 實際結果 | 通過／失敗／跳過 |
|---|---|---|---|
| 改前回歸 | `node --test MemberWebsocket-dev/tests/*.test.js` | exit 0 | 1916 / 0 / 0 |
| 新案例 RED | `node --test MemberWebsocket-dev/tests/integration/business_context_dom.cjs` | 原版本五項預期斷言失敗；另修正測試 cleanup 時未 disconnect observer 的 harness 問題 | 0 / 5 / 0 |
| 專項 GREEN | 上述 DOM 加 `business_context_connection.test.js`、`business_context_routing.test.js` | exit 0 | 24 / 0 / 0 |
| 專項 Chromium | `npm test -- business-context-dom.spec.cjs` | exit 0 | 2 / 0 / 0 |
| 改後 Node 回歸 | `node --test MemberWebsocket-dev/tests/*.test.js` | exit 0；已處理新測試清單及來源審查雜湊所觸發的兩項 inventory 失敗，未改弱斷言 | 1916 / 0 / 0 |
| scripts 回歸 | `node --test scripts/*.test.mjs` | exit 0 | 225 / 0 / 0 |
| CI 測試接線 | `node --test scripts/ci-test-inventory.test.mjs` | exit 0 | 3 / 0 / 0 |
| timer 品質 | `node scripts/runtime-quality.mjs --base 81de73c5b4f8772449649967f02a06f6a5abcfd5` | exit 0；0 新增／修改 timer | 不適用案例統計 |
| 建置 | `node scripts/build-site.mjs` | exit 0 | 不適用案例統計 |
| 依賴安全 | integration、browser 各 `npm audit --audit-level=low` | 均 exit 0、0 vulnerabilities | 無漏洞發現 |

全量 DOM／PGlite 及 Chromium 本機另有執行；本機 Node24 與 CI 的 Node22 fixture runtime 不同，最終判定仍須完整同 SHA CI。實體 PostgreSQL 的 disposable Docker service 與 Edge Deno 由既定 GitHub CI 執行，不在測試會員資料庫執行破壞性驗證。未改 LINE Provider 互動，不以 stub 宣稱真人登入或訊息實機重新驗證。

## 同條件效能比較

命令：`node scripts/benchmark-business-context-dom.mjs 81de73c5b4f8772449649967f02a06f6a5abcfd5`。固定 200 個連結、20 個 startup 消費端、20 批獨立文字更新，5 輪、交錯前後順序。量測時間、Node 版本、每輪數據與限制見 [原始 JSON](business-context-dom-20261125.json)。

| 指標 | 基準 | 候選 |
|---|---:|---:|
| startup 全頁 selector 查詢 | 328 | 15 |
| startup 額外既存連結寫入 | 400 | 0 |
| startup HTTP | 1 | 1 |
| 20 批局部更新全頁 selector 查詢 | 280 | 0 |
| 20 批局部更新既存連結寫入 | 4000 | 0 |
| 局部更新 HTTP | 0 | 0 |
| startup 合成耗時 p50 | 1978.94 ms | 56.48 ms |
| 局部更新合成耗時 p50 | 3373.24 ms | 0.79 ms |

結論限於實際 JS 在相同 JSDOM 的掃描／寫入工作量及合成耗時；不代表真實手機、API、SQL、LINE 或外網 p50/p95 已提速。既有 HTTP 去重保留，沒有藉由省略授權讀取換取效能。

## 已知限制與下一步

- 獨立 code review 發現兩項 Important：活動頁重用 anchor 恢復 href 後 gate 未恢復，以及移到 iframe 的節點仍被原文件處理。新增兩項 RED 斷言（0 通過／2 失敗）後修正，專項 24/24 與 390/1280px Chromium 通過；href 觀察僅處理本 document 的 anchor，URL 冪等。沒有未處理的 Critical/Important finding。
- 審查附帶的量測規模註記已區分「1,000／100 的驗收測試」與「200／20 的重複量測」，並補同一元素 all/any/route 優先順序案例。未擴大產品架構或增加新依賴。
- 完整 CI 成功前不可合併／部署。後端授權與資料庫隔離由既定完整 CI 驗證；真實 LINE、正式環境與外網效能未因前端審查而視為重新驗證。
- Project #5 連接器 403，無法移卡；Repository、PR 與 CI 可獨立處理。
- 資料庫 advisory 的缺外鍵索引與累積 pg_stat_statements 屬另案優化候選；未據此刪索引、放寬權限或改動資料庫。

## 執行與回復

安裝既有 pinned test dependencies：`npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration`、browser 同路徑；依既定 workflow 安裝 Chromium。沒有應用新套件或 DB migration。以 `node scripts/build-site.mjs` 建置。

回復時 revert 此 PR 開發提交，重跑完整 CI，再由既有測試發布管道更新測試站；無資料還原、LINE 設定或正式操作。任何正式發布需要此任務另行明確授權。
