# 正式與測試環境 LINE 設定

| 用途 | Git 分支 | 唯一編輯來源 | 發布網址 |
|---|---|---|---|
| 正式 | master | MemberWebsocket-dev/config/production/config.json | https://memberwebsocket-dev-netlify.netlify.app |
| 測試 | Integrated-Marketing-Platform | MemberWebsocket-dev/config/testing/config.json | https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app |

兩個來源會各自建置為該網站的 `/config/config.json`。修改後必須提交至對應分支並讓完整 CI 和發布流程成功；GitHub 檔案更新不代表網站已更新。舊版 `/config.json` 是相同內容的相容產物，請勿直接修改。環境變數不覆寫這兩份來源。

## 各 LIFF 的 Endpoint

| config 欄位 | 網站路徑 | 用途 |
|---|---|---|
| memberLiffId | /member/ | 會員卡 |
| pointsLiffId | /points/ | 集點卡 |
| adminLiffId | /admin/ | 一般管理員帳號入口 |
| platformLiffId | /platform/ | 總管理員 |
| eventLiffId | /event/ | 活動票券 |
| calendarLiffId | /calendar/ | 活動日曆 |
| bookingLiffId | /booking/ | 預約 |

在 LINE Developers 對應 LIFF 中，Endpoint URL 必須填「該環境發布網址 + 網站路徑」。商家自有 LIFF 還需保留商家 `?business=...`，並依既有商家 LINE 設定處理；帳號入口的 config 不會覆蓋商家已儲存的身分設定。

一個 LIFF ID 只有一個 Endpoint，不能同時指向正式及測試。直接開啟 `https://liff.line.me/{LIFF_ID}` 時，第一段導向由 LINE 控制，網站的 config 無法改寫另一個 LIFF 的 Endpoint。請為兩環境設定不同 LIFF，勿把錯誤的跨站跳轉當作登入解法。

2026-11-15 查核：正式 admin `2011356226-8ztJZFaz` 指向正式 `/admin/`；測試 admin `2010791619-vhevCvvD` 指向測試 `/admin/`。原正式部署仍使用後者，因為 `product_admin_ui.cjs` 寫死舊值導致 CI 拒絕發布。本次改為兩環境各自的設定契約測試，不放寬發布 Gate。

**仍需個別設定：** 當前兩份 JSON 的 pointsLiffId、eventLiffId、calendarLiffId、bookingLiffId 相同。已查核共用 points LIFF 的 Endpoint 指向測試商家。使用這些入口前須建立或選用各環境專用 LIFF，再填入對應 JSON；本次不猜測或建立 LINE ID。

測試總管理員既有 LIFF 的 Endpoint 仍為 `/admin/platform/`，網站會相容導向 `/platform/`。登入保留 SDK 原生 Endpoint 回跳；不要直接指定不在該 Endpoint 路徑下的 redirectUri，否則 LINE 會拒絕。可於 LINE Developers 將此既有 Endpoint 更新為 `/platform/`，但本輪不改寫 LINE 後台設定。

## 後端 Channel 與身分驗證

`platform-api` 依伺服器的 Supabase 專案 URL，僅從上表固定的所屬 Netlify 網站讀取 `/config/config.json`，並檢查 Supabase URL 和 API URL 均符合本環境。總管理員取 platformLiffId 的 Channel 前綴；一般管理員帳號入口取 adminLiffId。讀取不接受 request body、Origin、轉址或使用者提供的設定網址。

讀取結果在單一執行個體最多快取 60 秒，併發首次登入共用一個設定讀取；設定逾期且網站無法讀取時回 503，不沿用過期 Channel。LINE token 的簽發者、audience、效期、LINE User ID 與伺服器角色仍逐次驗證。商家自有登入維持由資料庫決定可信任的商家 Channel，不能由前端指定。

首次部署此版 platform-api 後，未來修改帳號入口 LIFF 跨 Channel 時，待對應網站完成發布、最多再等 60 秒即可讓 platform-api 依新設定驗證。商家自有設定、會員 API 和其他業務函式仍遵守現有各自設定，不因帳號入口變更而改寫。

## 驗證與回復

1. 核對 GitHub 本次 SHA 的 Test MemberWebsocket Dev、Test Netlify build、Ticket Policy 全成功。
2. 核對發布流程、Netlify deploy ID、頁面 data-commit 與 `/config/config.json` 的實際內容。
3. 用手機 LINE 分別開啟兩個專用 admin/platform LIFF，確認網址、身分驗證與角色結果。合成 LINE SDK 測試不代表本人已完成此驗收。
4. 前端可 revert 本次修復，或恢復上一個已驗證 Netlify deploy；platform-api 保留發布前完整函式檔案以便回復。無 DB migration 或會員資料異動。
