# 管理端真人操作 E2E 補齊（2026-10-05）

範圍：GitHub `yongshengchen0615/yongshengchen0615.github.io` 的 `MemberWebsocket-dev`，原始 commit `ba2ac17904e212f90e162f742f3d607d29275bec`。Supabase 專案 `dbuquirnaskrwcamdxki`；本次沒有資料庫 migration 或 Edge Function 變更。

這次逐一檢查六個管理工作區及其動態加入的控制，補上 13 個管理端 Runner 節點。Full 路徑現在登記 52 個管理端節點。另以 47 個功能群組對應 92 個隔離瀏覽器操作案例；加上原有相機/GPS 案例，Chromium lane 共 100 個案例。

## 證據的範圍

- 線上管理端 Runner：沿用正式 Session 與 API，新增節點操作 UI；會寫入的節點只建立本輪唯一名稱的草稿，讀回驗證後刪除。固定票券不執行全域發券、不發 LINE 通知。
- 隔離 Chromium：載入正式 HTML、CSS 與 UI handlers，真正點擊、輸入、勾選、下拉選擇、拖曳、送出與重載；登入、地圖搜尋、收據圖片及資料持久化使用明確的本機 transport。未建模的 API 立即失敗；外網請求阻擋。
- DOM integration：執行相同操作案例及正式 Runner 函式，檢查 handler 與失敗判定；它不能證明瀏覽器排版、原生可操作性、剪貼簿權限或實際裝置效果。
- SQL integration：沿用 production SQL 的 PGlite 測試，驗證預約與票券結算、權限、版本衝突、冪等性及 QA 清理邊界。隔離 transport 的成功不代表正式資料庫或 LINE 已成功投遞。

每個瀏覽器案例附上 transport 呼叫證據；失敗保存 screenshot/trace，JUnit 由 CI 留存。未執行、略過、失敗仍依既有 coverage report 顯示，不提升為「完整通過」。正式 LINE 收件、實體相機/GPS、第三方地圖服務與排程時效仍使用既有實機/排程驗收。

## 本次發現與修正

| 問題 | 修正及驗證 |
|---|---|
| 固定票券刪除會 reset 成一般票券，使完成請求無法釋放儲存按鈕 | 請求完成時釋放自己持有的按鈕；四種週期刪除後重新新增都檢查按鈕可用 |
| 日曆批次新增按鈕需先選日期，旧節點直接按鈕無效 | 先選取日期；存在使用者未儲存批次或選取時明確略過，保留草稿 |
| 日曆修改僅比對輸入框，儲存遭拒可能誤判成功 | 確認完成儲存且月曆項目顯示伺服器回傳的新名稱；第二次寫入拒絕時驗證節點失敗並清理 |
| 日曆載入會置換 DOM，Runner 點擊舊元素可能沒有事件 | 等待目前的唯讀項目並重新取得元素後操作，確認資訊視窗及編輯鎖定 |
| 原生滑鼠點上下移時，拖曳 pointer capture 將 click 轉向卡片、打開編輯器 | 排序按鈕不啟動拖曳捕捉；Chromium 驗證上移、下移、儲存與重載，同時保留拖曳案例 |
| 部分功能只有控制存在或契約檢查 | 新增完整編輯、儲存、回讀、刪除、限制及失敗案例，證據層級與功能對照保持分開 |
| 未建立功能清單與可執行測試的一對一關係 | `admin-human-coverage.json` 對應全部案例；CI 拒絕缺失、重複及未映射案例；19 個 UI 來源變更要求重新盤點 |

## 新增管理端節點

| 節點 | 驗證內容 |
|---|---|
| `ADMIN_TIER_EDITOR_JOURNEY` | 四級會員全部卡面選取、預覽與草稿還原 |
| `ADMIN_TERMS_EDITOR_JOURNEY` | 版本開啟、啟用版唯讀、草稿計數、重新同意提示、重新載入 |
| `ADMIN_CARD_EDITOR_OPTIONS` | 十種樣式、到期切換、節點增刪與清除 |
| `ADMIN_CARD_SORT_JOURNEY` | 集點卡上下移與未儲存排序還原 |
| `ADMIN_EVENT_AUDIENCE_JOURNEY` | 五種票券類型與五組参加對象切換 |
| `ADMIN_FIXED_DRAFT_BIRTHDAY_MONTH` | 生日月份專用固定票券草稿 CRUD、回讀與清理 |
| `ADMIN_FIXED_DRAFT_WEEKLY` | 每週專用固定票券草稿 CRUD、回讀與清理 |
| `ADMIN_FIXED_DRAFT_MONTHLY` | 每月專用固定票券草稿 CRUD、回讀與清理 |
| `ADMIN_FIXED_DRAFT_YEARLY` | 每年專用固定票券草稿 CRUD、回讀與清理 |
| `ADMIN_CALENDAR_NAVIGATION` | 前後月、今天、日期帶入 |
| `ADMIN_CALENDAR_EVENT_CRUD` | 活動草稿、對象、連結、加贈點數及伺服器回讀 |
| `ADMIN_EVENT_CALENDAR_SYNC` | 專用活動草稿同步日曆、唯讀資訊、移除連結及清理 |
| `ADMIN_BOOKING_BATCH_EDITOR` | 批次服務編輯器新增/移除列與取消 |

## 功能對照

以下是隔離 Chromium 案例的功能對照；`RUNNER_*` 會呼叫正式登記節點本身，並檢查其回傳結果。全部案例都要執行，不以只有測試名稱或原始碼存在當作通過。

| 模組 | 功能 | 可執行案例 |
|---|---|---|
| 會員卡 | 會員名冊、搜尋、空結果與雙向分頁 | `MEMBER_DIRECTORY` |
| 會員卡 | 會員資料、停用與恢復 | `MEMBER_PROFILE_STATUS` |
| 會員卡 | 會員 360 全部紀錄分類 | `MEMBER_360` |
| 會員卡 | 指定會員強制下線 | `MEMBER_FORCE_LOGOUT` |
| 會員卡 | 等級門檻儲存重載與四級全部卡面 | `MEMBER_TIERS`、`RUNNER_ADMIN_TIER_EDITOR_JOURNEY` |
| 會員卡 | 條款版本、唯讀、草稿、重新同意、啟用 | `MEMBER_TERMS`、`RUNNER_ADMIN_TERMS_EDITOR_JOURNEY` |
| 會員卡 | 預設訊息新增、修改與封存 | `MEMBER_PRESET`、`MEMBER_MESSAGE_SELECTION` |
| 會員卡 | 多卡集點、服務時數與三種通知模式 | `MEMBER_GRANT_immediate`、`MEMBER_GRANT_scheduled`、`MEMBER_GRANT_none` |
| 集點卡 | 集點卡完整編輯、到期、節點增刪、封存與刪除 | `POINT_CARD`、`RUNNER_ADMIN_CARD_EDITOR_OPTIONS` |
| 集點卡 | 排序上移下移、還原、儲存與重載 | `POINT_SORT`、`POINT_DRAG`、`RUNNER_ADMIN_CARD_SORT_JOURNEY` |
| 集點卡 | 使用張數 0、2、50 儲存重載 | `LIMIT_points_0`、`LIMIT_points_2`、`LIMIT_points_50` |
| 集點卡 | 一般與抽獎票券模板生命週期 | `POINT_TEMPLATE_coupon`、`POINT_TEMPLATE_lottery` |
| 集點卡 | 抽獎獎項增刪、機率拒絕與平均分配 | `LOTTERY_EDITOR_template` |
| 集點卡 | 使用地點搜尋、選取、名稱、範圍、調整與刪除 | `LOCATION_template` |
| 集點卡 | 兌換節點指定服務 any/all | `SERVICE_RULE_any`、`SERVICE_RULE_all` |
| 活動票券 | 一般、推薦、加入會員、抽獎票券 CRUD、對象、日期與配額 | `EVENT_coupon`、`EVENT_referral`、`EVENT_membership_join`、`EVENT_lottery` |
| 活動票券 | 所有類型與五組參加對象快速選取 | `RUNNER_ADMIN_EVENT_AUDIENCE_JOURNEY` |
| 活動票券 | 固定票券生日、每週、每月、每年；四種期限與通知/日曆選項 | `FIXED_birthday_month`、`FIXED_weekly`、`FIXED_monthly`、`FIXED_yearly` |
| 活動票券 | 四週期專用草稿回讀修改刪除與清理 | `RUNNER_ADMIN_FIXED_DRAFT_BIRTHDAY_MONTH`、`RUNNER_ADMIN_FIXED_DRAFT_WEEKLY`、`RUNNER_ADMIN_FIXED_DRAFT_MONTHLY`、`RUNNER_ADMIN_FIXED_DRAFT_YEARLY` |
| 活動票券 | 每日票券 0、2、50 儲存重載 | `LIMIT_event_0`、`LIMIT_event_2`、`LIMIT_event_50` |
| 活動票券 | 抽獎獎項增刪、機率拒絕與平均分配 | `LOTTERY_EDITOR_event` |
| 活動票券 | GPS 地點搜尋、範圍、調整與持久化 | `LOCATION_event` |
| 活動票券 | 指定服務 any/all 條件儲存 | `SERVICE_RULE_any`、`SERVICE_RULE_all` |
| 營運日曆 | 前後月、今天、日期帶入與編輯器 | `CALENDAR_NAV`、`RUNNER_ADMIN_CALENDAR_NAVIGATION` |
| 營運日曆 | 休假與活動 CRUD、對象、日期區間與連結 | `CALENDAR_holiday`、`CALENDAR_event`、`RUNNER_ADMIN_CALENDAR_CRUD` |
| 營運日曆 | 批次日期選取、新增、修改、刪除、空值拒絕與清除 | `CALENDAR_BATCH`、`RUNNER_ADMIN_CALENDAR_BATCH_CONTROLS` |
| 整合中心 | 四個檢視、通知狀態、稽核類型、搜尋與重新整理 | `INTEGRATION` |
| 整合中心 | 發放、服務、活動、預約、日曆、固定與生日票券導覽 | `INTEGRATION_NAV_member-grant`、`INTEGRATION_NAV_booking-services`、`INTEGRATION_NAV_events`、`INTEGRATION_NAV_booking-queue`、`INTEGRATION_NAV_calendar-batch`、`INTEGRATION_NAV_fixed-new`、`INTEGRATION_NAV_birthday-fixed-new` |
| 預約 | 服務類型 CRUD 與時數集點回饋規則 | `BOOKING_TYPE` |
| 預約 | 服務 CRUD、時數價格與加購搭配 | `BOOKING_SERVICE` |
| 預約 | 服務批次新增修改刪除、增減列與取消 | `BOOKING_SERVICE_BATCH`、`RUNNER_ADMIN_BOOKING_BATCH_EDITOR` |
| 預約 | 技師新增修改、停用恢復與主要技師保護 | `BOOKING_TECHNICIAN` |
| 預約 | 主要技師與預約人數儲存重載 | `BOOKING_RESOURCE_SETTINGS` |
| 預約 | 跨夜時段、提前日數、公用時間、提醒與說明 | `BOOKING_SHARED_SETTINGS` |
| 預約 | 確認、不通過、取消、完成與結算視窗 | `BOOKING_STATUS_confirmed`、`BOOKING_STATUS_rejected`、`BOOKING_STATUS_cancelled`、`BOOKING_STATUS_completed` |
| 預約 | 現場改單項目數量、空值拒絕與回讀 | `BOOKING_ITEMS` |
| 預約 | 會員持有票券增減、額度與未領票券禁止代領 | `BOOKING_BENEFITS` |
| 預約 | 多人逐位項目與技師調整、重複與主要技師驗證 | `BOOKING_PARTICIPANTS` |
| 預約 | 取消申請保留/確認取消及審核鎖定 | `BOOKING_CANCELLATION_approve`、`BOOKING_CANCELLATION_reject` |
| 預約 | 安全收據檢視、關閉及 URL 清除 | `BOOKING_RECEIPT` |
| 預約 | 無障礙登記、略過、已完成紀錄與狀態篩選 | `BOOKING_ACCESSIBLE_register`、`BOOKING_ACCESSIBLE_dismiss`、`BOOKING_ACCESSIBLE_BENEFITS`、`BOOKING_ACCESSIBLE_EXISTING` |
| 營運日曆 | 活動加贈集點儲存、回讀與休假停用 | `CALENDAR_BONUS`、`RUNNER_ADMIN_CALENDAR_EVENT_CRUD` |
| 活動票券 | 活動同步日曆、唯讀資訊、連結移除與日期必填 | `EVENT_CALENDAR_SYNC`、`RUNNER_ADMIN_EVENT_CALENDAR_SYNC` |
| 預約 | 複製完整預約資訊 | `BOOKING_COPY` |
| 共用拒絕邊界 | 儲存衝突、結果不確定與權限拒絕的錯誤呈現 | `WRITE_FAILURE_CONFLICT`、`WRITE_FAILURE_API_RESPONSE_UNCERTAIN`、`WRITE_FAILURE_ADMIN_FORBIDDEN` |
| 共用拒絕邊界 | Runner 寫入拒絕不誤判成功、僅清理本輪草稿 | `RUNNER_REJECTED_ADMIN_CALENDAR_CRUD`、`RUNNER_REJECTED_ADMIN_FIXED_DRAFT_WEEKLY` |
| 共用拒絕邊界 | 必填、活動日期反向與不安全連結拒絕 | `INVALID_EDITORS` |

## 執行與維護

```sh
node --test --test-concurrency=4 MemberWebsocket-dev/tests/*.test.js
node --test --test-concurrency=2 MemberWebsocket-dev/tests/integration/*.cjs
cd MemberWebsocket-dev/tests/browser
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium --only-shell
npm test
```

`ADMIN_JOURNEY_FILTER` 只供本機診斷；CI 不設定它。若 UI 來源 fingerprint 變更，先盤點新增/移除功能、更新測試與功能對照，再更新該來源 SHA-256。禁止只更新 fingerprint 以略過盤點。

正式部署依 GitHub main/Pages 發布，測試 fixtures 不被任何正式 HTML 引用。所有正式資產版本已更新，lazy loader 宣告與實際請求版本一致。

## 驗證結果與發布門檻

- 回歸測試：628 項全部通過。
- 管理端操作 DOM lane：92 個操作案例全部通過，含套件父測試共 93 項；沒有略過案例。
- 既有其他 DOM/SQL integration：100 項通過；本次新增操作案例的最後修正已獨立完整重跑。
- 功能映射、63 種模組組合排程、資產版本與 lazy loader：17 項針對性驗證全部通過。
- 47 個正式 JavaScript 與瀏覽器測試檔案語法檢查通過。
- 原生 Chromium：100 個案例全數通過，包含新增 92 個管理端案例及既有 8 個相機/GPS 案例，沒有略過。[CI 證據](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/runs/37252043072)。本機 Chromium 的 `SIGTRAP` 啟動限制不作為通過證據。
- DOM 輔助程式新增等待動態勾選欄位及下拉選項的行為，避免非同步資料尚未載入的競態；實際 Chromium 的原生等待行為維持不變。
- 變更已發布至 [PR #278](https://github.com/yongshengchen0615/yongshengchen0615.github.io/pull/278)。使用者已明確要求合併 `main`；完整 Chromium 與其他 CI 檢查通過後合併，並驗證該合併 commit 的 Pages 部署。測試執行期間沒有修改線上會員資料。
