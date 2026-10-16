# MemberWebsocket-dev 程式碼與效能分析

分析日期：2026-09-16。基準 commit：`31f96c0b11ef86ef0ff7110218316f60cf59ff85`。

## 結論與範圍

優先改善重複同步及 API 的查詢等待鏈，保留現有完整載入與授權規則。本次修改五個 MemberSystem 前端入口的同步排程，以及主要 `api` Edge Function 的獨立讀取；不需要資料庫 migration，不更換框架或套件。

FACT：專案是 GitHub Pages 靜態前端，透過 LIFF 取得 ID token，再呼叫 Supabase Edge Functions。Realtime 主要傳遞資料失效通知，前端收到後重新取得經授權的資料。它不是直接以 WebSocket 傳送完整會員資料的架構。

盤點包含 41 個非測試瀏覽器 JavaScript 檔案、13 個 Edge Function 入口及 53 個 migration 檔案。深入檢查範圍為主要 API 的 bootstrap、會員/點數/票券資料流、管理端完整載入、共用 Realtime、預約同步與日曆查詢、相關安全驗證與 CI。沒有對每個業務操作完成端到端驗收。

ASSUMPTION：保留「管理端所需區塊全部取得後才顯示」的現有設計；會員列表仍使用既有 100 筆分頁，完整載入不等於一次下載所有會員。

未取得正式環境查詢計畫、API 延遲分布、資料量及真實連線數，因此不能宣稱整站加速百分比或可承載會員數。

## 已實作的改善

| 問題與證據 | 修改 | 效果與邊界 |
| --- | --- | --- |
| 五份 `common.js` 只以 650ms timer 合併事件，沒有等待刷新 callback 完成；`realtime-resync.js` 另有頁面恢復排程 | 將 Realtime、重新連線、pageshow、online、visibilitychange 集中在同一訂閱排程 | 同一訂閱最多一個刷新 callback 在執行；期間的事件合併為一次後續刷新，不丟掉資料失效訊號 |
| 背景分頁仍可因 Realtime 啟動重讀 | 隱藏或離線時保留待刷新狀態，恢復後同步 | 減少無人在看的分頁所發出的 bootstrap；仍保留 WebSocket 訂閱本身 |
| 包裝層重複 subscribe 會增加生命週期 listener | 保留原本訂閱去重，由 common.js 擁有並清理 listener | 重複訂閱不再增加額外的頁面恢復回呼；取消訂閱會清除 timer 與 listener |
| `Promise.resolve(onUpdate())` 無法接住 callback 同步拋出的例外 | 在 Promise callback 內呼叫 onUpdate | 同步例外或 Promise rejection 都會釋放刷新鎖，後續事件仍能更新 |
| `profileFor` 依序查等級、服務分鐘數 | 兩個互不依賴的讀取平行執行 | 兩段依序等待改成一組等待；仍使用同一會員 ID 過濾 |
| `admin.bootstrap` 與 `membersPage` 各查一次等級設定 | 同一次已授權請求共用設定 Promise | 等級設定查詢 2 次 → 1 次；沒有全域會員快取 |
| `pointBootstrap` 先等 profile 再查卡片，發票後又依序查餘額及票券 | profile 與卡片資料平行；發票完成後餘額及票券平行 | 保留逐卡發票順序，避免改變交易鎖定行為；空卡片不再發出空 ID 查詢 |
| 點數使用紀錄為每個卡片 UUID 執行 `activeCards.find` | 建立 cardId → title Map | 卡片標題對照由平方級掃描改成線性建表/查找 |
| 活動票券 profile、活動清單、使用紀錄及領取統計依序等待 | 按依賴關係分兩組平行讀取；日曆 profile 與 items 亦平行 | 保留停用活動的已使用紀錄、會員 claim 過濾及原有回應欄位 |
| 主要 workflow 未執行完整 `tests/*.test.js`，未檢查主要 api 入口 | CI 執行全部 Node 測試，使用 Node 24，加入 api 型別檢查 | 新增 38 項回歸測試會在之後的 PR/push 自動執行 |

同步排程保留原本 650ms 的事件合併等待，刷新起始時間最少間隔 1500ms。這項取捨用於限制連續事件造成的重讀；不影響手動提交交易，也不讓前端快取成為業務授權來源。手動刷新與其他擴充模組各自發出的請求不在此訂閱鎖的全域保證內。

## 仍需優先處理的項目

以下是實際程式碼觀察及其推論，不表示已在正式環境重現。

| 優先級 | FACT：目前程式碼 | INFERENCE：可能影響 | RECOMMENDATION |
| --- | --- | --- | --- |
| 高 | `serviceMinutesForMembers` 讀取 `service_time_entries` 後在 Edge 加總；`adminEventTickets`、`eventBootstrap` 下載 claim 明細計數，未完整分頁 | 若超過專案 API 回傳列數上限，分鐘數、會員等級顯示或活動剩餘量可能不完整 | 先核對線上 schema 與資料規模，再將 sum/count 放進有明確授權的 SQL aggregate/RPC；增加超過回傳上限的整合測試 |
| 高 | `pointBootstrap` 每次對每張 active 卡呼叫 `issue_eligible_point_tickets`，目前忽略 RPC 回傳的 error | 卡片增加時，等待鏈隨卡片數增加；發票失敗可能仍回傳部分資料 | 以實際交易函式與鎖定順序設計批次 issuance，明確處理失敗；完成重複兌換/並行操作測試後才更動 |
| 中高 | `ensureMember` 每次讀取流程也會寫 `last_login_at` | 每次 bootstrap 增加 UPDATE、WAL 與索引維護，活動時間與登入時間語意混用 | 先確認欄位用途，將登入事件和最近活動分開，或明確約定更新節流；本次未改 audit/時間語意 |
| 中高 | `booking/admin/cancellation-review.js` 每 4 秒 fallback polling；整合管理端 cancellation 模組每 12 秒 polling，與 Realtime 並存 | 可見且在線時，即使無變更仍持續請求；獨立預約管理頁的定時器理論每分鐘約 15 次 | 增加可觀測的連線狀態與退避，讓 fallback 只在無法即時同步時啟用；必須保留漏通知補同步 |
| 中 | 管理端每次完整 bootstrap 套用 cards/events/calendar 並重新載入編輯表單 | 資料量大時渲染成本增加，且可能影響未儲存輸入；單純延後首次載入會破壞現有完整開頁需求 | 保留首次完整載入，後續按事件類型局部更新，加入 dirty-form 保護及跨管理員操作驗收 |
| 中 | 四個會員 common.js 幾乎相同，admin 另有差異；多個 MutationObserver 與額外覆寫模組 | 長期容易版本漂移，DOM 重建可能觸發連鎖處理 | 先以瀏覽器 Performance trace 找到重複 render，再逐步收斂模組；不要一次更換所有入口載入順序 |

Supabase 官方說明 `select` 預設有 1,000 列回傳上限，而且專案可以調整；此處沒有讀取線上設定，不能假定線上上限一定是 1,000：[JavaScript select](https://supabase.com/docs/reference/javascript/select)。

靜態資源量只能作為線索：目前 admin HTML 直接引用的本地 JS 約 216KB、booking 約 123KB（原始未壓縮位元組；不含 CDN 與動態載入）。沒有瀏覽器量測就不能把檔案大小視為主要瓶頸，也不應先用 minify 掩蓋重複 API 呼叫。

## 驗證與安全邊界

- 基準：46 項既有 Node 測試通過。
- 修改後：84 項 Node 測試全部通過，41 個瀏覽器 JavaScript 檔案通過 `node --check`，`git diff --check` 通過。
- 新增 25 項同步測試：五個入口分別驗證慢請求中的 100 個事件只排一個後續刷新、callback 並行數上限為 1、背景/離線暫停、重新連線、重複訂閱、取消訂閱、同步例外及 rejected Promise。
- 新增 13 項 API 測試：查詢可並行啟動、管理端等級設定只讀一次、發票與查詢順序、餘額與使用紀錄、空結果、讀取失敗、未授權管理員及停用會員。
- 測試使用假計時器與資料庫替身；沒有向會員發送通知、執行線上扣點或壓測正式資料庫。模擬 callback 次數不等於真實 API 請求次數。
- 身分驗證、管理員授權、member_id 過濾、CORS、限流、寫入重試策略、資料表/RLS/SQL RPC 均未修改。既有測試仍涵蓋 body size、格式拒絕、預約狀態轉移與基本權限拒絕，但不等於線上完整資安稽核。
- 沒有新增 token 持久化或跨請求會員快取，亦未放寬匿名讀取。Realtime 仍使用既有 `realtime_events`，沒有新訂閱含個資的表。

重現：

```bash
node --test MemberWebsocket-dev/tests/*.test.js
deno check MemberWebsocket-dev/supabase/functions/api/index.ts
git diff --check
```

## 部署、風險與回復

1. 確認 PR CI 通過；在 DEV 測試 LINE 返回頁面、斷線再連線、管理端刷新、會員集點卡與活動已使用紀錄。
2. 發布同一組五個 HTML、common.js 及 realtime-resync.js，避免舊 wrapper 與新排程混用。HTML 已更新版本參數。
3. 經既有流程部署 `api` Edge Function，包含它依賴的 `_shared/request-body.ts`、`_shared/line-flex.ts`。只部署前端不會啟用後端查詢改善。
4. 不需要 migration。回復時還原這次 commit 的前端檔案，並重部署基準版本的 api；資料庫沒有回復步驟。
5. 正式驗證需記錄各入口冷/熱啟動 p50/p95、每次操作請求數、資料傳輸量、DB query time、鎖等待及錯誤率。平行查詢會縮短等待链，但也增加單一請求的瞬間查詢並行度，整體容量必須以實際 DB 指標確認。

依賴維持既有 `@supabase/supabase-js@2.57.0`，本次沒有套件升級。已核對 [Supabase Changelog](https://supabase.com/changelog) 與 [Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)；本次只調整現有 subscribe 回呼及 Promise 排程，不涉及 Realtime schema 變更。
