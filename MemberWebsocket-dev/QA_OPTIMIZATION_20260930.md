# QA 功能優化與驗證（2026-09-30）

本輪依 Trello「經絡工程師個人品牌系統」QA 列表的七張卡片檢查現有 main、線上 Supabase 函式、資料庫狀態與瀏覽器入口。資料庫設定與測試資料在檢查期間有其他操作更新，本輪未切換維護設定或清除資料。

## 修正

- 活動優惠通知讀取資料庫的 `claimed` 狀態；相容既有 `available` 呼叫者。已領券即使總量額滿仍可使用，已使用／取消的領券不可再被宣告可領。
- 庫存計數沿用 `event_ticket_claim_counts`，與領券交易保持一致。通知只查該會員的領券，避免下載所有會員資料；排除刪除、階級不符、未生效與過期活動，固定票券僅顯示給持有人。
- 預約確認權益檢查 Account Status 與 Membership Status。資格未啟用時不列可用權益，也不觸發集點票券發行；收件人仍須符合伺服器綁定。
- 線上排程通知存在 `DEFAULT_eventLiffUrl`／`DEFAULT_EVENT_LIFF_URL` 名稱不一致，導致非空佇列執行時 ReferenceError。本輪修正並將線上動態 `get_line_setting` 設定讀取同步回程式庫。
- 排程通知用資料列 UUID 作為 LINE retry key；409 只有帶 accepted request ID 才視為成功。外部發送限制為十秒，避免無限等待。
- 教學目標被移除時跳至下一個有效步驟；沒有目標、畫面隱藏或 pagehide 時解除 inert 與遮罩。捲動／resize 版面工作每幀合併，離開教學取消待執行計算；開啟時仍同步定位，背景 Runner 不依賴動畫幀。
- 管理端條款儲存／啟用期間停用編輯、版本切換與重複操作，完成後依草稿／歷史版本恢復正確狀態；非法生效時間提供明確訊息並聚焦欄位。

## QA 對照

| QA 卡片 | 本輪處理與證據 | 仍需驗收 |
| --- | --- | --- |
| [工作時段與跨夜](https://trello.com/c/yw0nT1O7) | 既有跨夜與預約資料完整性回歸、PGlite 預約 SQL 與 UI 測試 | 管理端登入後完整 HTTP→UI 與跨月／跨年情境 |
| [會員條款](https://trello.com/c/LhP0mklc) | 條款編輯競態修正；DOM 驗證版本鎖定、日期錯誤、啟用後唯讀與會員申請／重新同意 | 真實會員完整登入與管理員啟用流程 |
| [教學導覽](https://trello.com/c/qsTxEQzY) | 動態目標復原、pagehide 清理與版面合併；五頁導覽與台北午夜 DOM 測試 | 實機 WebView、輔助科技、五頁實際瀏覽器全流程 |
| [活動優惠券](https://trello.com/c/S2iqRat9) | 通知領券狀態、額滿與持有人判斷修正；優惠券 SQL／定位編輯器回歸 | 兩個獨立瀏覽器 Session 最後一張併發 HTTP→UI |
| [前一天提醒](https://trello.com/c/8kxtOrHq) | 保留完整 datetime 與既有排程；通知傳送失敗／重試／409 行為測試 | 實際提醒工作到期、取消與改期後端全流程 |
| [六模組 E2E](https://trello.com/c/hJ7KHBcV) | 教學不再因目標消失持續鎖住操作；既有節點逾時／失敗重播回歸通過 | 管理員登入的六模組、兩個 seed 協同實跑 |
| [LINE 權益通知](https://trello.com/c/VtDiHS1A) | 三類權益、資格／收件人邊界、額滿／過期排除；排程常數修復與重試去重 | 實際 LINE 收件及完整預約確認 HTTP→LINE 驗收 |

## 驗證與變更控制

- 完整 Node 回歸：490 項；DOM 整合：36 項；Deno 通知測試：12 項；三個受影響 Edge Functions 型別檢查。
- 額外執行預約 UI／SQL、優惠券庫存／核銷 SQL 與定位編輯器整合測試。
- 本輪不修改資料庫 schema、RLS、角色、管理權限、LINE secrets 或現有部署來源。前端仍使用原 GitHub Pages 專案。
- 未完成的實際登入、實機與 LINE 驗收不得以單元／DOM 測試替代；七張卡片維持 QA，逐項補驗。
- 回復方式：revert 本輪 PR 並恢復三個 Edge Functions 之前的版本；不需要資料庫回滾。
