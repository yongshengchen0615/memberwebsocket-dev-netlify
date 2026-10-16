# 2026-10-14 單元測試與回歸除錯

## 範圍與基準

基準：`main` commit `58eae07d708dc0d787c74975f68c0fc36fabb14a`。

檢查會員、點數與活動票券、一般與快照預約、QR Code、登入與在線狀態、LINE 通知、管理端操作、資料庫交易與權限。測試使用既有 DOM fixtures、空表 PostgreSQL/PGlite fixtures 與 Chromium fixtures；Supabase 線上專案只進行唯讀的權限、函式與錯誤紀錄查核。

## 已重現與修正

| 問題 | 原因 | 修正與驗證 |
| --- | --- | --- |
| 快照更新會收合已展開的明細，並丟失鍵盤焦點 | 每次收據更新均重建全部 details 與 tab，未保留互動狀態 | 以 receiptId 保留展開狀態，恢復原 tab/summary 焦點；更新內容不會搶走外部焦點。DOM 與 Chromium 新增案例涵蓋重新整理與深連結手動收合。 |
| 切換會員後，舊收據請求阻擋新會員讀取；登出後舊回應仍可能回寫 | 清單只使用跨會員的 listLoading 布林值，未驗證回應所屬 session 或讀取版本 | 身分切換與存取終止使清單版本失效、清除收據操作與歷史；只接受目前版本與 session 的結果，舊 finally 不會解除新請求鎖。六項 DOM 情境涵蓋交錯成功、失敗、登出、重複刷新與同會員更新。 |
| Edge 活動優惠單元測試預期值過時，主 CI 沒有執行這組測試 | 回傳已新增服務限制欄位，但測試仍比對舊物件；主工作流程只有 deno check | 更新完整回傳預期並補上票券持有人、GPS、服務限制與庫存案例；主 CI 執行全部既有 Edge 單元測試與 LINE delivery 測試。 |

## 本機驗證

| 類型 | 結果 |
| --- | --- |
| Node 單元／行為／靜態合約測試 | 836 項通過、0 失敗 |
| DOM 與 PostgreSQL 整合測試（不含獨立管理端大型旅程） | 完整執行 253 項通過，新增第六項收據情境另行執行 6/6 通過；相同集合合計 254 項 |
| Deno Edge 單元測試 | 型別檢查與執行均通過，23 項、0 失敗 |
| JavaScript 語法、patch 空白與工作流程 YAML | 通過 |
| Chromium | 本機啟動收到 SIGTRAP；新提交的 Chromium 驗證以 GitHub Actions 為準，不將本機啟動失敗計為應用程式錯誤或測試通過。 |

基準 commit 的 GitHub Actions run `38547479115` 七個測試工作均通過。修正版本的完整管理端旅程、Chromium、Edge 與聚合驗證結果應查看此變更所屬 PR 的 `Test MemberWebsocket Dev` 工作流程。

## Supabase 查核

- 七張核心資料表（會員、預約、收據、點數餘額、點數票券及兩類 session）均啟用 RLS，anon/authenticated 沒有直接 SELECT 權限。
- 六個相關管理、快照、票券修改與測試登入 RPC 均禁止 anon/authenticated 直接 EXECUTE。
- 已部署點數保護函式包含衝突 INSERT 的處理，已部署無故未到函式包含 confirmed 狀態。先前日誌中的點數與即時事件 scope 錯誤不能直接判定為現行程式仍有問題。
- Security advisor 的「RLS enabled, no policy」屬 INFO，符合此專案經伺服器 API 操作的封閉資料表設計。另有 extension 位於 public 的 WARN，未在這次回歸除錯中變更 extension schema：[Supabase 說明](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)。

本次沒有修改資料庫 schema、線上會員資料或部署 Edge Function；修正位於前端、測試與 CI。

## 重跑

```sh
node --test MemberWebsocket-dev/tests/*.test.js
node --test MemberWebsocket-dev/tests/integration/receipt_refresh_state.cjs
deno test MemberWebsocket-dev/supabase/functions/_shared/*_test.ts MemberWebsocket-dev/supabase/functions/booking-line-notifications/delivery_test.ts
```

完整整合、管理端旅程與 Chromium 安裝／執行指令位於 `.github/workflows/test-memberwebsocket-dev.yml`。新的收據測試與 Edge 單元測試已納入該流程。
