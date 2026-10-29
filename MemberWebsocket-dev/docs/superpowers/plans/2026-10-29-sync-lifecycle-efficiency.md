# 商家同步生命週期與連線效率

基線：Integrated-Marketing-Platform `b817bb1439b6549658e9eb05d8558aa130fd8acd`。執行方式：同一工作階段直接完成。目標環境：既有整合分支 Netlify preview。

## 設計與決策

保留授權 revision polling、10 秒檢查、120 秒完整補查、錯誤退避與伺服器權限。相較改用新的廣播或跨分頁協調架構，修正現有排程的成本與資料隔離風險較低；本輪不新增依賴、DB、Edge 或商業規則。

已確認：MemberSystem 與 BookingSystem 的商家分支會將恢復事件一律排成 trailing probe；已送出的結果未檢查生命週期；BookingSystem 訂閱 key 未包含 business。這些問題由真實 JS runtime 的受控時鐘與延遲網路回應重現。

不變條件：同步提示不授權；所有查詢仍透過原有 token、business、伺服器授權；不同商家不能共用訂閱；更新中發生的改變保留一次後續檢查。隱藏或離線不啟動新查詢，回前景必查新版本。

## 驗收／影響矩陣

| AC | Given / When / Then | 路徑與測試 |
|---|---|---|
| AC-001 | Given 查詢未回應，When 同批前景恢復事件，Then 共用一次查詢 | member-system.js、booking/common.js；business_sync_lifecycle.test.js |
| AC-002 | Given 查詢中切背景，When 舊回應完成或先回前景，Then 不刷新過期結果並補查 | 同上 |
| AC-003 | Given 離線/pagehide/取消，When timer 或延遲回應，Then 不產生背景刷新或殘留訂閱；pageshow 恢復 | 同上 |
| AC-004 | Given 完整刷新中版本改變，When 恢復事件，Then 保留一次後續版本查詢，10 秒週期與補查不變 | 新測試 + business_sync_revision、connection_efficiency、realtime_performance |
| AC-005 | Given 不同商家，When 訂閱與取消，Then 各自查詢、互不取消 | BookingSystem + lifecycle 測試與既有 Chromium business-sync |

## 執行計畫

1. 先跑既有同步測試基線；新增實際 runtime 行為測試並確認 RED。
2. 兩個現有排程各加生命週期 generation、頁面暫停與過期結果檢查，合併同代查詢；Booking key 加 business。
3. 相同 runtime、虛擬時鐘、延遲回應量測 120 批恢復事件的前後 probe 數；不將結果冒稱真實網路 p95。
4. 全專案 regression、完整 GitHub CI（DOM、PostgreSQL、Chromium、Edge、安全 audit、建置與 wiring）、獨立 review。
5. CI 全綠後合併；核對 merge SHA 的全 CI、Netlify native branch deploy、read-only smoke。回復使用 revert 本 PR，無 DB 回復需求。

## 進度

- 既有同步基線 55/55 通過；新生命週期測試先重現 11 個失敗，修正後 14/14 通過。
- 獨立 reviewer 找出暫停查詢已結束後，恢復會多送一次查詢；新增精確次數斷言 RED 2 fail，再於 probe 開始時消費 queued，GREEN 20/20（生命週期與 revision）。無 Critical/Minor。
- 同條件 120 批恢復事件，兩種 runtime 都由 240 次 probe 降為 120 次；完整刷新均為 1 次。原始結果見 docs/validation/sync-lifecycle-benchmark-20261029.json。
- 本機 regression 1154/1154；scripts 137/137（TMPDIR 放工作目錄）；static build 成功。本機 Chromium 沒有執行檔，仍須 GitHub 完整 CI 真實瀏覽器證據，不能將本機失敗算通過。
