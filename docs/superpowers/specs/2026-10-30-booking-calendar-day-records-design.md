# 預約日曆日期紀錄視窗

目標：用戶點日期，先看當天自己的預約及快照紀錄，再按「開始預約」進入既有預約表單；移除日曆下方紀錄區。

已確認：基準 Integrated-Marketing-Platform / ab4772325f5868f334afaa6e64402d79d07b48b3，既有一般預約與快照 renderer、狀態 tabs、會員端 API 均可沿用。
決策：將原紀錄元件放進日期 dialog，以本機已載入的會員資料篩選。替代的複製卡片方案會造成操作/同步分歧，故不採。一般預約按 bookingDate，快照按 createdAt 的 Asia/Taipei 日期；這是本輪實作判斷。
不變條件：保留既有身分/商家/資源授權、預約/快照狀態與操作；不新增 API、SQL、依賴或額外點日期查詢。
歷史：過去、提前天數、超出範圍、休假日期可以查紀錄，但不得因此取得建立預約權限。月份可以往前瀏覽。快照模式也保留日曆。
相容：bookingId/receiptId 深連結開對應日期；更新/取消/改期後當日清單同步；切換會員清除舊日期與紀錄。

| AC | Given / When / Then | 驗證 |
|---|---|---|
| AC-001 | Given 多日會員預約，When 點日期，Then 視窗只列該日且保留原操作、狀態筆數 | DOM + Chromium |
| AC-002 | Given 可預約日期，When 按開始預約，Then 原表單帶入日期且日期視窗關閉 | DOM + Chromium |
| AC-003 | Given 空日期，When 點選，Then 空狀態清楚且無下方紀錄 | DOM + Chromium |
| AC-004 | Given 過去/休假/超界日期，When 查看紀錄，Then 無法開始預約 | DOM + Chromium |
| AC-005 | Given 跨 UTC/Taipei 午夜快照，When 選日期，Then 按 Taipei 送出日期篩選 | DOM + Chromium |
| AC-006 | Given 即時刷新/身分切換/深連結，When 更新，Then 正確日期資料且不保留前會員資料 | DOM + 既有 regression |

測試：基線 node --test MemberWebsocket-dev/tests/*.test.js = 1189 pass / 0 fail / 0 skip。候選執行完整既定 CI（三個產品 workflow）及新增 DOM/Chromium。後端契約不改，資料庫/Edge 仍由全 CI 回歸。真實 LINE 登入需要真人 session，fixture 不代表第三方已驗證。
回復：revert 本輪提交並由既有同 SHA CI gate 重建 Integrated-Marketing-Platform preview；無資料遷移。
