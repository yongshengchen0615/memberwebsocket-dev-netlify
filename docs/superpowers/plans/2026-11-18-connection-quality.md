# 品質、連線與非同步設計審查

基準：`4010a400236f494d1ce47c8027d1f2a391d07697`；來源／PR 目標：`Integrated-Marketing-Platform`；工作分支：`perf/event-driven-quality-gates-20261118`。
授權環境：MemberWebsocket-test `bmwhojszsnxliekkhrka` 與開發站；不修改 master、正式設定、正式資料或供應者帳號。

| 項目 | 事實／決策 |
|---|---|
| 目標 | 會員入口不重複讀取相同商家設定；票券摘要依成功事件更新；開工與 PR 嚴格審查品質、效能、連線及 timer |
| 身分 | 沿用 LINE ID token、既有 session 與伺服器驗證；不新增認證協定 |
| 權限 | 保留跨商家／會員隔離、feature grants、撤權同步；前端去重不能共享不同 endpoint/key/商家／feature 的結果 |
| 狀態 | 相同進行中初始化共用讀取；新完成 grants 優先；刷新期間變更保留一次最後刷新；舊身分回應丟棄 |
| 資料 | 無資料模型或 migration 變更；presence 的 Beacon 與 keepalive 明確攜帶原 session 商家；unscoped 省略 business |
| 限制 | 計時器可作必要截止，不能猜操作何時完成；完整既有 CI 不可削弱；stub 不代表真人 LINE 與實際網路提速 |

## 驗收與測試計畫

| AC | Given / When / Then | 主要案例／命令 |
|---|---|---|
| AC-001 | 核銷尚未完成；點擊按鈕；不在 800ms 猜測結果，成功事件後讀取摘要 | `event_summary_refresh.test.js`、Chromium `event-summary-refresh.spec.cjs` |
| AC-002 | 摘要讀取中；收到多個完成事件／切換身分／失敗；最多一個進行中請求及一個最後刷新，舊回應不覆蓋，deadline 可清理 | 同上，包含 100 個訊號、失敗、timeout、登出與商家切換 |
| AC-003 | 每次實作／PR 有新 timer 或程式變更；執行 Gate；缺用途／清理／測試或連線設計欄位即拒絕 | `node --test scripts/runtime-quality.test.mjs scripts/pr-change-risk.test.mjs scripts/governance-workflow.test.mjs`；`node scripts/runtime-quality.mjs --base <基準SHA>` |
| AC-004 | 相同／不同商家設定並行；收到任意順序回應或逾時；100 相同呼叫只發一次，隔離 endpoint/key/商家/feature，初始與 refresh 不互相誤拒 | `business_context_connection.test.js`、`business_context_routing.test.js`、原 feature grants 瀏覽器測試 |
| AC-005 | 商家 A session；切換商家 B 後隱藏頁面；Beacon 成功或 keepalive 回退均關閉 A，unscoped 不傳空 business | `presence_liff_lifecycle.test.js` 安裝實際 BusinessContext fetch wrapper |
| AC-006 | 最終候選；完整回歸與建置；原八個 CI lanes、Netlify build、ticket policy、aggregate validate 均通過才合併／開發部署 | `.github/workflows/test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`；同 SHA CI、部署及 smoke 另於 PR 記錄 |

## 最小方案與影響

選擇沿用既有事件、Map 與 Promise 協調；不引入狀態框架、長期快取、通用排程器或新依賴。完整重建 transport 的成本與回歸面較大，現有可重現缺陷不需要該方案。

- `business-context.js`：同進行中請求合併、15 秒截止涵蓋 body、商家世代及已完成序列；各 feature 的 LIFF identity 仍用該 scoped 回應。
- `event/today-usable.js`、`event/app.js`：取消點擊後固定等 800ms 的推測請求；成功領取／核銷與原 realtime／resume 觸發更新；一次最後刷新與身分防護。
- `member-system.js`、`booking/common.js`：presence 捕獲設定快照；具名 presence 操作才保留明確原商家。普通寫入仍跟隨選定商家，伺服器權限繼續檢查。
- 規範／PR／CI：開工前三項檢查、計時器例外、同條件量測、連線與非同步設計欄位及可執行 timer Gate。詞法檢查不是 JS 語意證明，跨行參數／動態呼叫仍需審查；不得聲稱已設定 GitHub Required Checks。

## 基線、量測與證據

基準完整應用 Node 回歸：1,548 通過、0 失敗、0 跳過。本輪新增測試先重現錯誤，再最小修正；最終版 CI 與驗收結果以 PR 同 SHA 紀錄為準。

同 Node 24 VM、相同合成 payload、每輪 100 並行 configure、重複 30 輪：基準每輪 100 requests／1 成功／99 錯誤；候選每輪 1 request／100 成功／0 錯誤，deadline 無殘留。這是可重現請求與結果計數，不是外網 p50/p95。API／SQL 無修改，不宣稱伺服器或外網本身變快。

完整產品 CI 提供 DOM、隔離 SQL／實體 PostgreSQL、Edge、Chromium、wiring、依賴 audit 與建置。外部 LINE 登入／通知與正式環境未因 stub／CI 而視為重新驗證。

## 已知待辦與回復

- P3：BusinessContext 每批 DOM mutation 全量掃描仍可優化；應另以大型 DOM 的 selector 次數及時間比較，驗證動態插入與撤權後再改，不混入本次連線修復。
- Supabase 測試專案唯讀 advisory：8 項缺外鍵覆蓋索引、157 項未使用索引、152 項 RLS 無 policy 的 INFO、1 項 pg_net public schema WARN。這些不等於可直接刪索引或放寬 RLS，須先對照實際查詢／service-only 存取與 migration。指引：[外鍵索引](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)、[extension schema](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)。本輪未改資料庫。
- Project #5 連接器回傳 403，不能聲稱卡片狀態已更新；程式庫、PR 與 CI 可獨立推進。
- 回復：revert 本 PR 的開發合併提交，重跑完整 CI 後由既有管道發布。沒有資料庫遷移或資料反向處理。
