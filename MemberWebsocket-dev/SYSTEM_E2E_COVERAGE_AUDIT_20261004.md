# 管理端與用戶端 E2E 功能覆蓋稽核（2026-10-04）

範圍：`MemberWebsocket-dev`，GitHub `yongshengchen0615/yongshengchen0615.github.io`，Supabase `dbuquirnaskrwcamdxki`。原始版本：`bbcfd1aeaff33614936b4b81d4f7bb09513d3872`。

## 結論

原本已有 E2E 架構，但尚未完整涵蓋目前功能，而且「完整」模式仍會抽樣略去部分已登記節點。DOM 元件存在、按鈕命名前綴符合分類，不能當成整個功能已完成端到端驗證。本次補上 16 個功能節點，並以 45 個功能群組追蹤登記、排程及實際結果。

完成狀態是「功能節點與 CI 已補齊」，不是「已登入線上管理端執行所有實機流程且全部通過」。相機與 GPS 已加入 Chromium 虛擬裝置驗證；LINE 真實收件與實體裝置權限仍需實機驗收，cron 健康已直接查核正式排程。

## 原始缺口與修正

| 原始問題 | 本次處理 |
|---|---|
| 完整管理端／用戶端路徑只取部分節點 | Full 模式納入全部登記節點，仍保留 seed 隨機順序、依賴順序與 locked replay |
| 介面分類清單被稱為完整功能覆蓋 | 保留清單檢查，新增獨立功能群組結果與契約／互動／生命週期／邊界證據層級 |
| 缺少等級、通知模式、生日／固定票券、定位、服務限制、無障礙與來源卡片節點 | 新增下表列出的 11 個管理端與 5 個用戶端節點 |
| 使用張數上限 0 被當作無效設定；活動額度檢查仍依賴舊文案 | 接受 0＝不限張數，核對目前已使用／剩餘數據及「今日已使用」標籤 |
| BookingBenefits.syncNow 立即返回造成舊畫面競態 | 等待 aria-busy 結束與 ready／empty 狀態，同步失敗明確回報 |
| 含略過結果仍顯示「全部通過」 | 產生 verificationStatus／coverageComplete；新舊歷史紀錄均顯示「覆蓋未完成」 |
| 管理端 Root 超過 80 個案例會拆批，只剩部分 Root 可見 | 後端上限提高至 500；正常完整 Root 保存為一筆；超限 Root 明確拒絕部分保存 |
| 用戶端超過 60 個案例被默默截短 | 明確拒絕超限，不省略案例；保存原始開始與結束時間 |
| 中文內容可能超出 HTTP payload 限制 | 以 UTF-8 byte 計算，逐步壓縮詳情；保留所有案例 key／status、Replay 與失敗截圖參照 |
| any／all 節點可能沒有專用資料而跳過 | 前置資料新增各一張 QA 服務限制票券，只引用同一 runTag 的啟用且非加購服務 |

## 新增節點及各頁登記數

此處是登記的完整路徑節點數（用戶端包含場景與重播編排節點），不等於已執行／已通過數；完整執行另外加入覆蓋摘要與真人操作證據案例。

| 頁面 | 原有 | 更新後 | 新增節點 |
|---|---:|---:|---|
| 管理端 | 28 | 39 | `ADMIN_TIER_SETTINGS`<br>`ADMIN_GRANT_NOTIFICATION_CONTROLS`<br>`ADMIN_POINT_LIMIT_SETTINGS`<br>`ADMIN_BIRTHDAY_SETTINGS`<br>`ADMIN_FIXED_TICKET_CONTROLS`<br>`ADMIN_TICKET_LOCATION_CONTROLS`<br>`ADMIN_TICKET_SERVICE_RULES`<br>`ADMIN_BOOKING_ACCESSIBLE_QUEUE`<br>`ADMIN_BOOKING_HISTORY_TICKET_SOURCES`<br>`ADMIN_BOOKING_RESOURCE_CONTROLS`<br>`ADMIN_AUTOMATION_HEALTH` |
| 會員卡 | 27 | 28 | `MEMBER_PHONE_COUNTRY_VALIDATION` |
| 集點卡 | 25 | 25 | 既有節點全部納入 Full 路徑 |
| 活動票券 | 25 | 25 | 既有節點全部納入 Full 路徑 |
| 營運日曆 | 24 | 24 | 既有節點全部納入 Full 路徑 |
| 預約 | 29 | 33 | `BOOKING_TICKET_RULES`<br>`BOOKING_ACCESSIBLE_MODE`<br>`BOOKING_HISTORY_TICKET_SOURCES`<br>`BOOKING_ACCESSIBLE_RECEIPT_BOUNDARY` |


## 45 個功能群組與實際節點對照

每個群組的「通過」只代表下列節點在該輪通過；契約節點不升格成硬體或外部服務的全流程驗收。日曆與整合中心等管理專屬設定，以 — 標示沒有對應用戶端編輯入口。

| 功能群組 | 管理端節點與層級 | 用戶端節點與層級 | 驗收限制 |
|---|---|---|---|
| 共用登入與 Session 權限 | 拒絕邊界：`ADMIN_AUTH_READY` | 拒絕邊界：`COMMON_TEST_SESSION`、`SECURITY_MISSING_SESSION`、`SECURITY_TAMPERED_SESSION`、`SECURITY_ADMIN_BOUNDARY` | 依節點證據層級判定 |
| 亮暗主題與偏好還原 | 介面互動：`ADMIN_THEME_TOGGLE` | 介面互動：`COMMON_THEME_TOGGLE` | 依節點證據層級判定 |
| 首次教學與操作恢復 | — | 介面互動：`COMMON_TOUR_AUTOSTART`、`COMMON_TOUR_JOURNEY` | 依節點證據層級判定 |
| 跨端即時更新 | — | 契約／結構：`COMMON_REALTIME` | 依節點證據層級判定 |
| 會員名冊、搜尋、分頁與紀錄 | 介面互動：`ADMIN_TEST_MEMBER_ROSTER`、`ADMIN_MEMBER_DIRECTORY_CONTROLS`、`ADMIN_MEMBER_MODALS` | — | 依節點證據層級判定 |
| 稱呼、生日、電話修改與還原 | 寫入生命週期：`ADMIN_TEST_MEMBER_PROFILE_EDIT` | 寫入生命週期：`MEMBER_HUMAN_PROFILE_EDIT`、`MEMBER_INVALID_WRITE` | 依節點證據層級判定 |
| 電話國碼與重複數字拒絕 | — | 拒絕邊界：`MEMBER_PHONE_COUNTRY_VALIDATION` | 依節點證據層級判定 |
| 條款版本、同意與拒絕 | 契約／結構：`ADMIN_MEMBERSHIP_TERMS` | 契約／結構：`MEMBER_TERMS_CONSENT` | 依節點證據層級判定 |
| 加入會員與 LINE 通知 | — | 契約／結構：`MEMBER_JOIN_LINE_AUTOMATION_CONTRACT`、`MEMBER_LINE_SUPPRESSION` | 正式 LINE 收件需實機驗收 |
| 好友邀請與自邀拒絕 | — | 拒絕邊界：`MEMBER_REFERRAL_BOUNDARY` | 依節點證據層級判定 |
| 會員等級、門檻與累積時數 | 契約／結構：`ADMIN_TIER_SETTINGS` | 契約／結構：`COMMON_MEMBERSHIP_MILESTONE` | 依節點證據層級判定 |
| 強制下線、撤銷與維護邊界 | 拒絕邊界：`ADMIN_FORCE_LOGOUT_SECURITY` | — | 依節點證據層級判定 |
| 預設訊息編輯與驗證 | 介面互動：`ADMIN_MESSAGE_PRESET_EDITOR` | — | 依節點證據層級判定 |
| 發放點數、時數與通知模式 | 介面互動：`ADMIN_GRANT_NOTIFICATION_CONTROLS`、`ADMIN_MEMBER_MODALS` | — | 排程 LINE 實際投遞由通知測試與實機驗收補充 |
| 集點卡 CRUD、節點與樣式 | 寫入生命週期：`ADMIN_POINT_CARD_CRUD` | 介面互動：`POINTS_DATA`、`POINTS_CARD_SWITCH` | 依節點證據層級判定 |
| 票券模板與封存 | 寫入生命週期：`ADMIN_TICKET_CRUD` | — | 依節點證據層級判定 |
| 抽獎券與機率設定 | 寫入生命週期：`ADMIN_LOTTERY_TICKET_CRUD` | — | 依節點證據層級判定 |
| 集點卡使用上限與 0 不限張數 | 契約／結構：`ADMIN_POINT_LIMIT_SETTINGS` | 契約／結構：`POINTS_SETTINGS` | 依節點證據層級判定 |
| 勾選、取消與核銷 | — | 寫入生命週期：`POINTS_HUMAN_REDEEM`、`POINTS_INVALID_WRITE` | 依節點證據層級判定 |
| 點數轉贈與輸入邊界 | — | 拒絕邊界：`POINTS_TRANSFER_BOUNDARY` | 依節點證據層級判定 |
| 集點卡票券使用紀錄 | — | 介面互動：`POINTS_HISTORY_DISCLOSURE` | 依節點證據層級判定 |
| 活動票券 CRUD 與領取資格 | 寫入生命週期：`ADMIN_EVENT_TICKET_CRUD` | 寫入生命週期：`EVENT_DATA`、`EVENT_HUMAN_LIFECYCLE` | 依節點證據層級判定 |
| 活動尚未開始、結束與封存 | — | 拒絕邊界：`EVENT_BOUNDARY_STATES` | 依節點證據層級判定 |
| 每日額度、已使用數與 0 不限 | 契約／結構：`ADMIN_EVENT_DAILY_LIMIT_SETTINGS` | 契約／結構：`EVENT_TODAY_USABLE_LIMIT` | 依節點證據層級判定 |
| 票券詳情與已使用紀錄 | — | 介面互動：`EVENT_MODAL`、`EVENT_HISTORY_DISCLOSURE`、`EVENT_INVALID_WRITE` | 依節點證據層級判定 |
| 壽星優惠設定與輸入驗證 | 介面互動：`ADMIN_BIRTHDAY_SETTINGS` | — | 年度去重與排程實際發放由 SQL／排程驗收補充 |
| 固定票券週期與效期切換 | 介面互動：`ADMIN_FIXED_TICKET_CONTROLS` | — | 實際 cron 發放需排程驗收 |
| GPS 使用地點編輯器 | 契約／結構：`ADMIN_TICKET_LOCATION_CONTROLS` | — | 實際定位權限與距離需裝置驗收 |
| 票券具體服務項目 any／all 限制 | 介面互動：`ADMIN_TICKET_SERVICE_RULES` | 拒絕邊界：`BOOKING_TICKET_RULES` | 依節點證據層級判定 |
| 營運日曆與活動 CRUD | 寫入生命週期：`ADMIN_CALENDAR_CRUD` | — | 依節點證據層級判定 |
| 日曆批次編輯與拒絕邊界 | 介面互動：`ADMIN_CALENDAR_BATCH_CONTROLS` | — | 依節點證據層級判定 |
| 月份、今日與日期明細 | — | 介面互動：`CALENDAR_NAVIGATION`、`CALENDAR_HUMAN_DETAIL`、`CALENDAR_INVALID_DATE`、`CALENDAR_SERVER_BOUNDARY` | 依節點證據層級判定 |
| 時段、跨夜、提前日數與通知 | 寫入生命週期：`ADMIN_BOOKING_SHARED_SETTINGS` | — | 依節點證據層級判定 |
| 服務類型、項目、價格與技師 | 介面互動：`ADMIN_BOOKING_CRUD`、`ADMIN_BOOKING_RESOURCE_CONTROLS`<br>`ADMIN_AUTOMATION_HEALTH` | — | 依節點證據層級判定 |
| 日期、項目、時段與確認步驟 | — | 介面互動：`BOOKING_FORM_INITIAL`、`BOOKING_FLOW_STEPPER`、`BOOKING_HUMAN_CONTROLS` | 依節點證據層級判定 |
| 新增、修改與取消預約 | — | 寫入生命週期：`BOOKING_HUMAN_LIFECYCLE`、`BOOKING_INVALID_WRITE` | 依節點證據層級判定 |
| 多人預約與參與者服務 | — | 寫入生命週期：`BOOKING_GROUP_DATA`、`BOOKING_HUMAN_GROUP` | 依節點證據層級判定 |
| 推薦、勾選、點數預留與核銷交接 | — | 寫入生命週期：`BOOKING_BENEFITS_RECOMMENDATIONS`、`BOOKING_BENEFIT_REDEMPTION_LIFECYCLE`、`BOOKING_TICKET_RULES` | 依節點證據層級判定 |
| 收據相機入口與管理端安全檢視 | 契約／結構：`ADMIN_BOOKING_RECEIPT_VIEWER` | 契約／結構：`BOOKING_RECEIPT_REVIEW_CONTRACT` | 實際拍照、Storage 上傳與替換需相機驗收 |
| 無障礙模式、可用票券與登記狀態 | — | 介面互動：`BOOKING_ACCESSIBLE_MODE`、`BOOKING_ACCESSIBLE_RECEIPT_BOUNDARY` | 依節點證據層級判定 |
| 無障礙待確認、已完成與全部 | 介面互動：`ADMIN_BOOKING_ACCESSIBLE_QUEUE` | — | 實際審核與冪等結算由 accessible SQL 整合測試補充 |
| 預約紀錄的集點卡／活動票券來源卡片 | 契約／結構：`ADMIN_BOOKING_HISTORY_TICKET_SOURCES` | 契約／結構：`BOOKING_HISTORY_TICKET_SOURCES` | 依節點證據層級判定 |
| 整合總覽、權益、通知與 Audit | 介面互動：`ADMIN_INTEGRATION_CENTER`、`ADMIN_INTEGRATION_NAVIGATION` | — | 依節點證據層級判定 |
| 測試帳號新增、選取與移除 | 寫入生命週期：`ADMIN_TEST_MODE_CONTROLS`、`ADMIN_TEST_ACCOUNT_LIFECYCLE` | — | 依節點證據層級判定 |


## 線上歷史紀錄核對

查詢時有 2 筆測試執行紀錄；並無整體專案完整通過的證據。

- `QA-20261004-74BAA81D`：10 個案例，9 通過、1 略過，舊狀態標示 passed。本次介面會顯示覆蓋未完成。
- `UE2E-MUT4OF67-8B323BEA`：26 個案例，23 通過、2 失敗、1 略過。失敗為 `BOOKING_HUMAN_LIFECYCLE` 與 `BOOKING_RECEIPT_REVIEW_CONTRACT`。
- 該預約的 `cancellation_requested_at` 已有值、`cancellation_reviewed_at` 為空，表示取消申請已寫入；測試的畫面判定卻為 false。本次先核對後端，再在必要時刷新畫面，並仍要求後端與畫面同時符合，沒有只靠後端成功就放行。
- 收據視窗的一般／無障礙標題與幫助文案會切換，舊文字比對只認得初始化文案。本次納入兩種正式文案，並用反例確認「送出即完成」仍失敗。

## 驗證與 CI

- Node 回歸：626 項通過、0 失敗（相較原始 614 項，新增 12 項測試）。
- DOM／SQL 整合：79 項通過、0 失敗（新增 8 項真實頁面腳本整合測試）。
- 所有 63 種非空管理端模組組合：每個登記節點都納入 Full 計畫，功能群組沒有漏登記／漏排程，依賴順序正確。
- 5 個用戶端頁面：完整登記節點全部納入 Full 計畫，既有安全／真人操作／Mutation 節點保留。
- 瀏覽器與共用 JavaScript：68 個檔案語法檢查通過。
- CI 保留回歸、DOM／SQL、JavaScript 語法、全部 Edge Functions 型別與靜態 wiring 五條驗證路徑，並加入新檔案。
- 本機 Deno 曾因 registry.npmjs.org 連線遭拒而受阻；GitHub Actions 已完成全部 Edge Functions 型別檢查，結果通過。

## 實機與外部驗收項目

1. 收據：一般與無障礙相機拍攝、拍攝取消、真實 Storage 上傳／覆蓋、管理端審核及結算冪等性。已有無效輸入與 SQL 結算整合測試，但本次未使用實體相機。
2. GPS：定位允許／拒絕、允許距離內外、裝置位置變更。新增定位編輯器契約，不假造真實定位成功。
3. LINE：正式會員加入、立即通知、排程通知的實際收件。測試會員維持通知隔離。
4. 固定票券／生日：週期、效期與欄位驗證已有節點；排程實際觸發、年度去重及通知需以排程工作紀錄驗收。
5. 登入後協同 Full E2E：在現有測試模式與維護閘門下執行全部模組，查看管理端與每個用戶端的功能覆蓋摘要。沒有 fixture／權限／可用時段時會顯示阻擋，不列為通過。

## 使用方式

管理端 → 測試管理 → 勾選模組／測試會員 → 開始所選模組完整 E2E。結果新增管理端與各用戶端的功能群組通過比例、證據層級及未通過節點；查看案例中的 Expected／Actual、失敗代碼、Trace 與截圖定位第一個差異。

本次 QA 服務限制票券沿用 `qa:e2e:<runTag>` 所有權與現有手動測試資料清理流程；沒有資料庫 schema 變更。


## 發布與線上驗證結果

- 程式提交：[`938004c`](https://github.com/yongshengchen0615/yongshengchen0615.github.io/commit/938004c76889fbc7ed4a70a6653d74bfbb4d69c1)。
- [GitHub CI](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/runs/37177672223)：回歸、DOM／SQL、瀏覽器語法、Edge Functions 型別、靜態 wiring 與最終 Validate 全部成功。CI 回歸紀錄為 626 項通過、0 失敗；DOM lane 的 Node 測試為 75 項通過，並執行另列的預約、SQL 與定位編輯器檢查。本機直接以所有 `.cjs` 執行的統計為 79 項通過。
- [GitHub Pages](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/runs/37177671945)：部署成功。
- 6 個入口 HTML 與 5 個共用／管理端／用戶端測試腳本已逐檔與發布來源比對，11 個線上檔案內容完全一致；6 個入口均載入新版功能覆蓋模組。
- Supabase `test-control-api` v32、`user-test-api` v24 均為 ACTIVE；回讀部署來源與本次提交一致。`user-test-api` 的共用 Session helper 同步到儲存庫既有的 60 秒使用時間更新節流版本。
- 無身分 POST：管理端 API 回應 HTTP 401／`AUTH_REQUIRED`，用戶測試 API 回應 HTTP 401／`TEST_SESSION_REQUIRED`。原有自訂身分驗證仍生效。
- 本次未以 LINE 管理員身分執行整輪線上 Full E2E，亦未開啟實體相機；不能由上述 CI／部署成功推論所有實機及外部服務流程已驗收。


補充功能群組：`automation.health` → `ADMIN_AUTOMATION_HEALTH`（member／event／booking 範圍，boundary 證據）。

## 後續實作與部署（2026-10-04 第二次修正）

- 生日管理節點改測現行 `fixed-ticket-automation` 與生日月份固定票券編輯器；整合測試移除停用的 `birthday-benefits` 模擬回應，避免失效 API 被測試掩蓋。
- 固定票券 QA 模板僅發给 `is_test_account=true` 的會員，測試帳號不建立 LINE 發送佇列。指定模板／會員的排程測試不再讓其他正式票券或 claim 過期，保留營運日曆同步。
- 新增 production SQL 行為測試：生日一年一次及修改生日、跨年、週／月／年週期、月底與閏年、四種效期、額度、會員等級、QA 隔離、通知條件、未來日期作用範圍。
- 新增 `ADMIN_AUTOMATION_HEALTH`：檢查固定發券、LINE 排程、預約 LINE、前一天提醒、E2E 附件清理的啟用狀態、最近結果與時效。RPC 僅 service role 可執行，不公開 cron 命令、Token 或錯誤原文。cron SQL 成功只證明排程執行，不代表 LINE 最終收件。
- 新增 Chromium E2E：正常／無障礙相機拍攝、真實 Canvas/JPEG、HTTP 圖片上傳、送審邊界、權限拒絕後重試、重新拍攝、重複送出鎖定、不確定結果重试，以及 GPS 拒絕／範圍／重試。使用 Chromium 虛擬相機、瀏覽器定位與本機 API/Storage fixture；實際 Supabase 收據原子替換／審核／結算由既有 production SQL 測試補充。
- GitHub Actions 新增必要 `browser-e2e` 檢查與失敗 trace、畫面、JUnit 留存；Validate 必須六條測試工作皆成功。

已驗證：626 回歸測試、92 DOM／SQL 整合測試；Supabase migration 與 `test-control-api` v33、`user-test-api` v25 已部署；正式資料庫以交易回滾驗證 QA 發券隔離、重复發券及零通知。五個主要 cron 皆 active、fresh、最近 succeeded。Chromium 8 個流程已由 Ubuntu GitHub Actions 實際執行通過。


### 最新線上失敗紀錄修正

2026-10-04 05:07–05:13 UTC 的協同執行揭露以下問題，均已加入修正與回歸驗證；原失敗紀錄保留，未改寫成通過。

| 線上失敗 | 修正 |
|---|---|
| MEMBER_PROFILE_WRITE／MEMBER_HUMAN_PROFILE_EDIT: INVALID_PHONE | QA 正常写入改用新版電話規則接受的號碼，UI 指定台灣國碼並以正式 E.164 normalizer 比對回讀 |
| 四頁 BUTTON_COVERAGE 未辨識教學控制、會員條款更新 | 明確納入既有教學與條款節點；各頁新按鈕未知時仍會失敗 |
| BOOKING_HISTORY_TICKET_SOURCES: INVALID_CLIENT_TYPE | 使用 booking-api 現行 member bootstrap 契約，新增真正來源卡片比對的整合測試 |
| EVENT_HUMAN_LIFECYCLE 第二張票超過每日 1 張 | 用 service-only QA 日期 fixture 將本人 QA UI 已使用票券移至前一個測試日；正式每日上限、正式歷史與其他會員資料不變，E2E 留存 fixture 影響筆數 |
| 管理端優惠交接誤判缺少待核銷資訊 | 比對現在的 `.booking-ticket-status.status-pending` 與票券名稱，符合目前卡片 UI |
| 第二位起的協同用戶教學被略過，完整覆蓋永久未完成 | 每位用戶完整走教學、還原個別儲存狀態；保持錯誤清理，避免 inert 鎖住後續節點 |
| Chromium fixture 被正式 CSP 阻擋 | fixture 改用同來源外部腳本與正式 CSS，保留 production CSP；8 個相機/GPS 流程全部通過 |

瀏覽器證據：[Chromium E2E 成功工作](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/runs/37180326482)。該次整合工作抓到的教學變數錯誤已修正；最新版 8bc8f9e 的六條工作與整體 Validate 全部成功。


### 最終部署證據

- 首次完整通過的程式版本：`8bc8f9e5628c277fa120839f3794f27af8f87be6`；[完整 CI／Validate 成功](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/runs/37180450845)。六條必要工作全部通過；Chromium 8 個流程無略過。
- [GitHub Pages 部署](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/runs/37180450544)完成；六頁入口與四個 E2E JS 已逐檔核對發布内容與本地版本一致。
- Supabase `test-control-api` v33、`user-test-api` v25 為 ACTIVE，所有相對依賴已讀回比對；未登入請求分別維持 401 AUTH_REQUIRED／TEST_SESSION_REQUIRED。
- 三個 migration 已部署：QA 固定發券隔離、service-only 排程健康、本人 QA 活動券日期 fixture。正式資料庫以回滾交易驗證發券去重／零通知與日期 fixture，不留下驗證會員或票券。
- 本地結果：626 回歸、92 DOM／SQL 整合全部通過；五個主要 cron active、fresh、最近 succeeded。
- Advisors：既有 service-role-only 表 RLS 無直接用戶 policy（INFO）、既有 pg_net public schema（WARN）、3 個未使用索引（INFO）；本次未增加授權或效能告警。

這些證據完成程式實作、可自動化驗證與發布。尚未以真實 LINE 收件者或實體手機進行硬體驗收，也未將先前失敗的登入協同 Root 紀錄改寫成成功；應以部署後新執行的 Root 判定該次線上完整結果。


協同教學的儲存還原已限縮為當前使用者的雜湊 key，新增五頁同時有其他參與者寫入的回歸驗證，避免完整教學並行時還原其他會員的偏好。

另修正延遲身分雜湊在頁面離開／關閉後仍嘗試開教學的競態，新增晚到回呼測試；教學整合等待已解析的 storage key，解除 CI 計時假設造成的偶發錯誤。最新版狀態以 [main 分支 CI](https://github.com/yongshengchen0615/yongshengchen0615.github.io/actions/workflows/test-memberwebsocket-dev.yml) 為準。
