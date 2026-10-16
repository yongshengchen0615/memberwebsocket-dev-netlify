# 全站 UI 整合：2026-10-07

需求卡：https://trello.com/c/BECc6lsi

## 盤點與選擇

盤點基準為 main `06ee688`。既有 `theme.css` 已有明暗色、Material 3 token 與 Header 適配；`experience.css` 是全站共用呈現層，因此延伸它，避免增加另一套設計系統。`ui-components.js` 僅生成票券資訊 DOM，不執行請求、判斷權限或修改資料。

| 頁面／功能 | 元件與狀態 | 分類與實作 | 保留的差異 |
|---|---|---|---|
| 管理端六工作區、五用戶端與入口 | Shell、Header、標題、間距、欄位縮放 | 共用 content width、spacing、radius、surface 與文字換行 | 各工作區資訊密度、桌機欄數與既有導覽 |
| 管理端一般／無障礙預約 | 狀態篩選、紀錄卡、Badge、操作列 | 共用 `experience.css` status filter 與 record surface；刪除兩份重複 filter 定義 | 狀態集合、收據審核、核銷流程與事件 |
| 全站表單／設定 | label、helper、checkbox、disabled、focus | 共用間距、縮放、touch target 與語意色 | Server validation、欄位需求與交易 busy guard |
| 全站狀態 | Loading、Empty、Error、Submitting、Success | 共用 state/feedback 視覺；好友清單 aria-busy、loading/ready/empty/error；綁定中不顯示成功樣式 | 依功能保留錯誤說明與恢復動作 |
| 會員卡／活動票券／日曆 | Header、狀態、主要操作 | 共用 Shell、標籤與動作排列 | 會員卡階級外觀、活動領取與日曆互動維持獨立 |
| 集點卡／一般預約／大字預約 | 票券名稱、來源、點數、狀態、CTA | 共用 `.ui-ticket` 與 `MemberUI.pointTicketDetails` | 預約選取、票券核銷與大字 font modifier |
| 好友與邀請 | Modal、查找、分享、好友清單、QR | 單一入口三區，既有掃描器與安全 parser | 加好友與獎勵各自明確確認；好友接受權限不變 |
| Modal／Drawer／Confirm | 捲動、關閉、鍵盤焦點 | 沿用 `dialog-accessibility.js` 與既有遮罩；好友視窗補背景 inert 與原狀恢復 | 不抽交易控制器，避免變更送出次數、Escape busy 行為 |
| 預約紀錄票券／收據 | ticket summary、receipt frame | 既有 `booking-ticket-cards.css` 已供兩端共用，保留 | 收據 signed URL 與審核紀錄不能和一般票券選取共用 |

## Before / After

| 整合項目 | Before（已查 Repo） | After | 驗證位置 |
|---|---|---|---|
| 服務對象 | `friends.js` 在預約說明前動態插入獨立「替誰預約」卡片 | 同一控制項移入預約資料 fieldset，與本人／好友及聯絡資料同一層 | `friends_ui.cjs`、`ui-layout.spec.cjs` |
| 好友視窗 | 共用一個 Modal，但標題與分享／查找／好友層級不清，還顯示 readonly 完整 URL | ①邀請有禮 ②加好友 ③我的好友；複製與分享兩個動作，QR／會員編號入口 | `friends_ui.cjs`、`member-p2.spec.cjs`、`ui-layout.spec.cjs` |
| 邀請識別 | 好友 lookup 支援會員編號；獎勵綁定僅接受 10 碼邀請碼 | 新分享／QR 只帶會員編號；Server 轉既有 invite code 後交原 RPC，舊連結仍可用 | `referral_member_identifier_behavior.test.js`、既有 referral／QR 回歸 |
| 預約說明 | 營業時間 Badge 顯示「每 X 分鐘切分」 | 保留營業時間、隔日及提前天數，移除內部切分資訊 | app diff、完整 regression |
| 票券資訊 | 集點卡頁自行建立來源／需求／餘額 DOM；預約頁顯示 subtitle 與 condition | 共用 definition list，兩頁相同 ticket surface；大字模式放大同一 DOM | `booking_benefits.cjs`、`ticket_booking_choice.cjs`、`booking_accessible.cjs`、`ui-layout.spec.cjs` |
| 狀態篩選 | 兩份近乎相同 CSS，含頁面硬寫顏色 | 一組 selector pattern 與 semantic token；橫向捲動只限 filter 本身 | `booking_admin_status_filter_ui.test.js`、既有 admin browser suites |
| 成功回饋 | referral status 將所有非 error 訊息（含綁定中）套 success | Server 綁定回應後才套 success；其餘為 info/error | DOM referral 回歸 |

## 安全、相容性與風險

- 不改 Schema、Authentication、好友接受權限、票券資格／點數公式、預約狀態與 Realtime 契約。
- `member-growth-api` 新增會員編號 adapter。識別來自已驗證的 session；會員資料須 active、會員资格 active、條款有效，再執行 rate limit 下的既有操作。
- adapter 僅在相同 `is_test_account` 範圍查找 active inviter，invite code 不回傳 Client。最後由原 `bind_member_referral` 再驗證本人、重複綁定、獎勵配置與 idempotency。
- UI 共享只生成文字节点，無 HTML 注入；QR parser 保留 origin/path allowlist，不導向掃描出的網址。
- 保留 ticket ID、booking recipient ID、checkbox data attributes 與原事件，並更新變更資產的 cache version。
- 部署先發布向後相容的 Edge adapter，再合併前端。回復可 revert PR；舊前端仍可呼叫新 adapter，無資料 migration。

## 驗證證據

本機 Node regression：678 tests 全通過。相關 DOM／交易、QR、餘額、資格、帳號切換、焦點、無障礙与啟動回歸見同 PR 的 DOM lane。

`ui-layout.spec.cjs` 使用正式 HTML/CSS/呈現與事件，在隔離 transport 上檢查 320、390、1280px × 明／暗色，五用戶端及管理端六工作區；確認文案換行、頁面／卡片無溢出、兩頁票券 computed style 一致、選擇不觸發寫入、好友複製回饋與背景 inert 恢復。各組畫面附在 GitHub Actions 的 `memberwebsocket-browser-*` artifact。既有完整 Chromium 與 Edge type-check lanes 也必須通過才能合併。

本機 Chromium 受執行環境限制無法啟動，因此使用 CI Chromium 驗證與截圖，並非以靜態檢查代替瀏覽器證據。測試 transport 不包含真實 LINE 訊息送達，也不證明各實體手機的相機權限；QR 真實影格／圖片解碼已有既有瀏覽器測試。
