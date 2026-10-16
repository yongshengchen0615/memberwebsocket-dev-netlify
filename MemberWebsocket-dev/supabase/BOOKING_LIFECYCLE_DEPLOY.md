# 會員改約與服務完成確認

本次修改範圍為 `MemberWebsocket-dev`，不修改其他正式目錄。

## 流程

- 會員只能修改自己的 pending／confirmed 預約，且原預約尚未開始。
- 修改項目、日期、時段及備註後，狀態重設為 pending，清除舊確認資訊。
- 後端依現有提前天數、上班時間、項目啟用與休假規則驗證；目前價格重新快照。
- SQL 在同一交易鎖定原預約、檢查版本、更新預約與項目、寫入稽核；任何一步失敗全部回復。資料庫排除約束防止時段重疊。
- 相同 requestId 重送回傳同一筆結果，不重複寫入稽核。
- 管理員僅能將 confirmed 預約標記 completed，且必須已到預定服務結束時間（台北時間）。完成後不可透過預約 API 修改或取消。
- 完成服務不會自動發放會員點數或服務時間，維持既有發放流程。

## 部署順序

1. 先執行本次 `booking_member_edit_and_completion` SQL migration。保留現有資料，新增 completed_at／completed_by 欄位及改約 RPC，RPC 僅授權 service_role。
2. 重新部署 `supabase/functions/booking-api/index.ts`；沿用現有 LINE Token 驗證與部署設定。
3. 再發布本次前端變更。管理端確認操作現在必須傳入 expectedUpdatedAt，已開啟的舊頁需重新整理。

不需重新部署 GAS、booking-admin-api 或 booking-calendar-api。

## 已執行驗證與限制

- Node 24：`node --test MemberWebsocket-dev/tests/*.test.js`，8 項生命週期測試及 3 項既有測試通過。
- 隔離 PostgreSQL 相容 PGlite fixture：新時段衝突回復原資料、資料擁有權、版本衝突、改約待確認、重送不重複稽核、已完成不可改約。
- JSDOM：改約帶入資料、排除自身占用、傳送舊版本、更新既有預約、清除修改狀態。
- JavaScript 語法與 diff 空白檢查通過。
- PGlite fixture 並非線上完整資料庫；未驗證正式資料、LINE 登入或正式部署。
- Cloud Browser 無法連入本機預覽，尚未完成真實瀏覽器／實機視覺驗收。

重現整合測試（只安裝開發測試依賴）：

```sh
npm ci --prefix MemberWebsocket-dev/tests/integration
node MemberWebsocket-dev/tests/integration/booking_sql.cjs
node MemberWebsocket-dev/tests/integration/booking_ui.cjs
```

發布前需在測試環境檢查 320／390／768／1440px、手機橫向、鍵盤焦點、LINE 內嵌瀏覽器與輸入時的畫面。確認既有休假識別色與設定不受影響。

## 回復

回復前端及 booking-api 至先前版本。保留新增欄位、RPC 及 completed 狀態約束以保護已完成紀錄，不應直接刪除資料或把 completed 改回 confirmed。舊前端不認識 completed，若已產生完成紀錄，應保留本次狀態顯示修正再回復其他部分。
