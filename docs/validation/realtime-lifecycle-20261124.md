# 測試專案即時同步驗證紀錄

對應 [Issue #443](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/443)。基準 `3e4369293ba6a3190617704cdc06a0fda340e378`；範圍僅 `Integrated-Marketing-Platform`／MemberWebsocket-test。實際程式 SHA256、Node 版本與量測時間見同目錄 JSON。

## 需求與不變條件

使用者明確選擇優化既有 WebSocket／授權 revision 機制。訂閱、暫停、清理與恢復由原模組管理，不新增公用資料頻道、認證協定、長期快取、寫入重試、依賴或資料庫變更。伺服器身分驗證、商家隔離、撤權、原通知及業務規則保留。

## 重現與修正

- WebSocket 新增案例先跑 11 tests：8 fail、3 pass；失敗重現離開頁面殘留 channel、晚到事件污染，以及設定切換重用舊訂閱。修正後同步相關 90/90 通過。
- 櫃檯新增案例先跑 6 tests：3 fail、3 pass；修正後 6/6 通過。背景或離線讓舊世代失效；正常前景訊號共用查詢；全量刷新中保留一次補查。
- 完整 JSDOM 新案例先證明舊預約清單仍會重繪（true !== false），之後在 `load(expectedSyncGeneration)` 兩個等待邊界檢查世代。整份 frontdesk_ui.cjs 17/17 通過。
- 既有 listener 數斷言由 3 更新為 5，因新增 offline/pagehide 兩個清理事件；仍要求全部移除及單次訂閱。沒有刪除或放寬清理斷言。
- 逐項覆核原 62 組管理流程，保留全部人工旅程映射，更新兩個實際變動來源的審查雜湊；新增 socket Chromium 案例由原 browser glob 執行。
- 獨立審查列出 2 項 P1 與 4 項 P2，新增重現案例先得到 12 fail。已處理同一櫃檯登入的背景拒絕、舊登入拒絕不終止新登入、停用清理、跨訂閱等待移除、暫停登入補查與 SDK 重連例外。相鄰預約登入亦先重現同樣舊回應問題，再套用相同憑證綁定。補上完全停止後重新訂閱的生命週期重設，相關 65/65 通過。
- 保留安全例外：仍連線、僅隱藏的頁面收到登入被取代提示時，必須向伺服器重新確認撤權；pagehide／離線後則等實際恢復。既有 takeover 行為案例不變，對應靜態斷言更新為明確的 `verifyCurrentLogin(true, true)` 呼叫。

## 同條件前後量測

命令：`node scripts/benchmark-realtime-lifecycle.mjs 3e4369293ba6a3190617704cdc06a0fda340e378 docs/validation/realtime-lifecycle-20261124.json`。

| 受控情境 | 基準 | 候選 |
|---|---:|---:|
| member／booking pagehide 後活躍 channel（各自） | 1 | 0 |
| pagehide 後安全補查時鐘觸發刷新（各自） | 1 | 0 |
| member 退訂後 100 對延遲 event/status 造成的全域通知 | 200 | 0 |
| 櫃檯使用暫停前 probe 啟動全量讀取 | 1 | 0 |
| 慢速櫃檯刷新後立即補查（100 個恢復訊號） | 0 | 1 |

只代表相同合成 SDK/API、實際 JS runtime、可控時鐘下的連線／工作量；不代表真實外網 p95 或 LINE 手機速度。

## 本機驗證與限制

| 檢查 | 實際結果 |
|---|---|
| 基準應用回歸 | 1807 pass、0 fail、0 skip |
| 候選應用回歸 `node --test --test-reporter=tap MemberWebsocket-dev/tests/*.test.js` | 1839 pass、0 fail、0 skip |
| 櫃檯 DOM `node --test --test-reporter=tap MemberWebsocket-dev/tests/integration/frontdesk_ui.cjs` | 17 pass、0 fail、0 skip |
| timer／治理／inventory | 17 pass、0 fail、0 skip；新 timer sites 0 |
| integration npm audit | 0 vulnerabilities（54 dependencies） |
| browser npm audit | 0 vulnerabilities |
| scripts（實體 PostgreSQL 專用測試交由 CI） | `node --test --test-concurrency=1 --test-reporter=tap`，220 pass、0 fail、0 skip |
| 測試站靜態建置 | `BRANCH=Integrated-Marketing-Platform CONTEXT=branch-deploy node scripts/build-site.mjs`，exit 0 |
| 本機 Chromium | 啟動受環境 Unix socket EPERM 阻擋；2 案例未執行，不計通過 |
| 完整 PostgreSQL／Edge／Chromium 與三條 CI | 必須由最終 SHA 的 GitHub Actions 確認，不能用本機部分結果取代 |

曾將建置與會寫入同一 `dist` 的 scripts 測試同時執行，產生 ENOENT；改為依序執行，未改測試斷言或產品建置。完整命令／退出碼、最後 CI 與測試站發布證據追加至 Issue／PR，並以其最終 SHA 為準。

回復：revert 本輪提交並重新跑測試分支 CI／發布；無 DB／會員資料回復。LINE 真人登入、手機網路切換不在合成 transport 測試的通過範圍，既有登入流程本輪未改動。
