# 測試專案連線與即時同步生命週期

使用者選擇先優化既有機制。來源／目標為 `Integrated-Marketing-Platform`，基準 `3e4369293ba6a3190617704cdc06a0fda340e378`；僅使用 MemberWebsocket-test 與 Netlify 測試分支站。

## 目標與決策

沿用 MemberSystem／BookingSystem 的 Supabase WebSocket，以及商家頁面與櫃檯的授權 revision 查詢。與重新設計私有推播相比，修正既有生命週期可直接回歸，無新增身分協定、依賴、SQL、Edge 或正式設定。

已確認：MemberSystem 的 channel 回呼沒有退訂後防護；兩個共用入口的 socket 未隨 pagehide/offline 釋放；MemberSystem 僅依 clientType 共用訂閱；櫃檯背景／離線不會讓進行中查詢失效，恢復訊號可能被進行中請求吃掉。先由測試逐項驗證，再修改。

不變條件：同步提示不能授權；商家資料只經原本 LINE 與後端授權取得。不同設定不得沿用舊訂閱；斷線不重送寫入；事件風暴只執行一個刷新並保留一次後續刷新。隱藏／離線／pagehide 不啟動資料讀取；回前景必重新核對。背景測試帳號的既有語意保留。

安全例外沿用既有契約：仍連線而僅隱藏的頁面收到登入被取代訊號時，向伺服器確認撤權；pagehide／離線仍禁止啟動查詢。同一登入的權限拒絕即使已暫停也必須清除私有畫面；舊登入或已重新啟動的櫃檯請求不能撤銷新登入。

## 驗收與影響

| AC | Given / When / Then | 測試 |
|---|---|---|
| AC-001 | Given 已退訂或已暫停的 socket，When 舊事件與狀態延遲抵達，Then 不觸發刷新、全域通知或污染新狀態 | realtime_connection_lifecycle.test.js |
| AC-002 | Given pagehide 或離線，When 重複恢復且舊 channel 尚在移除，Then 先完成移除、僅恢復一個 channel，並重新同步；停止後不再連線 | 同上；Chromium lifecycle |
| AC-003 | Given MemberSystem 設定／商家切換，When 再次訂閱，Then 釋放舊訂閱，不共用其他商家的 callback | 同上；business_sync_lifecycle |
| AC-004 | Given 櫃檯同步未完成，When 背景／離線再恢復，Then 捨棄舊結果、保留一次新查詢；相同前景事件不增加請求 | frontdesk_sync_lifecycle.test.js |
| AC-005 | Given 多筆事件與慢速刷新，When 事件持續抵達，Then 無重疊刷新且保留最後同步；既有授權、撤權與商家隔離不變 | 原同步／連線／安全回歸、完整三條 CI |
| AC-006 | Given 同一候選 SHA 完整 CI 成功，When 合併測試分支，Then 對帳發布 SHA、測試 Netlify 與非破壞性 smoke | GitHub Actions、測試站公開版本 |

## 量測與限制

以相同合成 SDK、實際 JS runtime、可控時鐘與 100 筆延遲事件比較活躍 channel、退訂後通知、刷新與授權查詢次數。這是資源／請求量測，不代表外網延遲或真實 LINE 手機驗收。沒有 DB 或認證變更，新增註冊／密碼流程測試不適用；完整既有 PostgreSQL、Edge、安全 audit、DOM、Chromium 基線仍必須執行。

回復：revert 此變更，重新走測試分支 CI 與發布；無資料回復操作。
