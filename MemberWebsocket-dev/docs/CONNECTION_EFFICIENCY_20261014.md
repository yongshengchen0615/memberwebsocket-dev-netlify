# 連線效率優化與驗證 — 2026-10-14

## 範圍與狀態

本機初次驗證以 `main` commit `23ef9cd826048c59815daed2bc74431728174c2a` 為基準；發布前另整合會員使用紀錄改版的 `63e86a0ecdbf36276b6a67e0888c6a7da1e5f9d1`，修改共用會員連線與預約端請求／訂閱生命週期。本機實作與測試已完成；發布流程為執行既有 GitHub Actions、驗證通過後合併 main。沒有更動 Supabase schema、Edge Function、RLS、會員資料或 LINE 通知。

## 確認的問題與修改

| 已確認的問題 | 修改 | 驗證 |
| --- | --- | --- |
| 預約端的相同並行讀取各自送出 POST | 六種既有讀取動作只共用尚未完成的請求；回應完成或失敗後立即移除 | 100 個相同時段讀取由 100 次 fetch 變為 1 次；下一次讀取仍發出新請求 |
| 可用權益、會員資料也可能被多個呼叫端同時讀取 | 所有上述讀取經相同請求合併流程 | 權益與會員資料各自合併，兩種讀取互不混用 |
| pageshow、visibilitychange、online 在同一恢復階段會排入多次登入檢查 | 同一背景切換版本的恢復事件共用正在執行的檢查 | 三種恢復訊號只產生一次登入檢查 |
| 若只合併登入檢查，隱藏前啟動的舊檢查可能取代前景重新驗證 | 背景切換／BFCache 恢復使檢查版本失效；登入取代通知仍要求一次後續檢查 | 既有漏通知前景登出回歸、新增背景競態與通知競態通過 |
| 預約端重複訂閱會增加 timer／listener，且單一全域 channel 無法獨立清理不同 scope | 以專案 URL、公開 key、scope 共用訂閱；每個訂閱保有自己的 client／channel | 重複訂閱只有一個 channel 與檢查 timer；會員取消訂閱不會拆掉管理端 channel |
| 取消訂閱後，尚未完成的登入檢查可能再觸發排隊工作 | 釋放 timer、listener、channel，捨棄取消後的排隊檢查及遲到 callback | 取消後不再送出後續登入檢查；重新訂閱可以正常啟動 |
| 快照取消未列入明確的寫入動作 | 將 receipt.cancel 納入寫入分類 | 回應不確定時回傳 API_RESPONSE_UNCERTAIN，不共用或重送寫入 |
| 管理端票券旅程測試取得新 ID 後，前一次儲存的 bootstrap 尚未完成就開始下一步編輯 | 測試在第二次編輯前等待儲存按鈕恢復可用 | 保留封存狀態與寫入結果斷言；coupon／lottery 旅程連續兩次重跑通過 |

這些是可重現的請求數改善，不能直接換算成整站延遲、正式流量降幅或可承載會員數。

## 安全與相容性

- 合併鍵包含 endpoint、公開 API key 與完整請求內容；LINE 身分、測試 session、clientType、動作與參數不同時不共用。
- 使用明確的讀取白名單。寫入、登入狀態檢查與未知動作不共用；寫入開始與完成均清除讀取共用狀態。
- 完成或失敗後不快取資料。舊讀取的 finally 不會刪除同鍵的新讀取。
- 登入取代／撤銷仍由伺服器判斷；前端事件只是重新驗證提示。收到撤銷時拒絕遲到的成功讀取並清理預約訂閱。
- 既有 30 秒檢查與補同步週期保留，背景與離線的刷新策略維持；沒有延長權限資訊的有效期限。
- 六個頁面更新共用資源版本，管理端 inventory 只更新 index.html 的 reviewed hash。管理端控制項與既有旅程不變，保留同日票券設定 UI 的 main 修改。

## 本機驗證

| 測試 | 結果 |
| --- | --- |
| 原始基準 Node 測試 | 836 項通過 |
| 整合最新 main 後的完整 Node 單元／行為／回歸測試 | 858 項通過、0 失敗；包含 18 項新增連線案例 |
| 完整 DOM／PGlite／管理端旅程整合測試 | 375 項通過、0 失敗（核心 237、完整管理端旅程 127、同日發布 11）；五支獨立整合檢查腳本亦通過 |
| 修改後額外重跑預約啟動、權益及收據刷新 | 17 項通過、0 失敗 |
| JavaScript 語法與 patch 空白 | 258 個 JavaScript 檔案語法通過；最後修改的共用模組與測試另行檢查，git diff --check 通過 |
| Chromium | 本機瀏覽器在測試頁面載入前即以 SIGTRAP 結束；未取得瀏覽器通過證據，需在既有 GitHub Actions 跑完整套件 |

測試使用假伺服器、隔離 DOM 與 PGlite fixtures；沒有對正式會員資料執行寫入、扣點、取消或通知。本機 Chromium 的啟動失敗不計為應用程式通過，也不歸因於業務程式。

Supabase 查核為唯讀：performance advisor 只有六個 unused-index INFO，未依此刪除索引；資料庫連線狀態快照不足以判斷壓力或容量。七張核心會員、預約、收據、點數及 session 表均啟用 RLS，anon／authenticated 沒有直接 SELECT 權限。已核對官方 [Realtime 清理文件](https://supabase.com/docs/reference/javascript/removechannel)及 changelog；本次不涉及已公告的 TLS cipher 變更或套件升級。

## 重跑與回復

```sh
node --test MemberWebsocket-dev/tests/*.test.js
node --test MemberWebsocket-dev/tests/integration/booking_startup.cjs MemberWebsocket-dev/tests/integration/booking_benefits.cjs MemberWebsocket-dev/tests/integration/receipt_refresh_state.cjs
git diff origin/main --check
```

完整 DOM／PGlite、管理端旅程、Chromium、Edge 檢查指令位於 `.github/workflows/test-memberwebsocket-dev.yml`。新增 Node 測試會由現有 wildcard 自動納入 CI。

回復時還原本次前端與版本參數即可，沒有資料庫或 Edge 回復步驟。

## 發布驗證

整合上述會員使用紀錄改版後，完整 Node 測試再次執行，862 項通過、0 失敗。首次本機整合測試結果仍記錄於上表；新基準的 DOM、Chromium、Edge 與其他檢查由本次 PR CI 驗證。

本次修改透過 `yongshengchen0615/yongshengchen0615.github.io` 的 `codex/connection-efficiency-20261014` 分支建立 PR，使用既有 CI 執行 Chromium 及整套驗證。實際 CI 結果、合併 commit 與 GitHub Pages 發布狀態以該 PR 和 main 對應的 Actions 紀錄為準。
