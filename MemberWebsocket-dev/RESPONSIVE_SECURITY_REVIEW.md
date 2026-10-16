# 跨裝置操作與 API 防護改善

基準：`43ad7385db259c37a10da27ba65934af061557e8`。範圍：MemberWebsocket-dev 的七個應用頁及十個接收 JSON 的 Edge Functions。

## 已修正

- 所有彈窗共用安全區域、動態視窗高度與內容捲動規則；關閉按鈕至少 44 × 44 CSS px；窄螢幕操作列可換行，稱謂編輯欄位改為單欄，長文字可換行。
- 七個頁面共用鍵盤焦點管理，依彈窗 z-index 選擇最上層，支援 Tab／Shift+Tab 循環、停用與隱藏控制項、無可操作控制項及可用時返回開啟按鈕。保留原有 Escape 和交易鎖定邏輯。頁面離開時清理 observer，從頁面快取返回時重新啟用。
- 減少動態效果設定會停止重複動畫。
- CSP 增加 `base-uri 'none'` 與 `object-src 'none'`，阻擋 base URL 改寫與外掛物件載入；沒有放寬原有腳本策略。
- API 共用 `_shared/request-body.ts`，依實際串流位元組限制大小，及早取消超量串流；保留各 API 原有大小上限，加入 10 秒接收期限。錯誤 JSON／UTF-8 回傳 400，超量回傳 413，接收逾時回傳 408；JSON 頂層只接受物件。
- 修正五個前端共用模組在即時訂閱清理時引用不存在的 `cancel` 變數；未完成讀取的合併鍵加入 endpoint 與登入 token，避免不同身分誤共用回應。Token 僅在記憶體中使用，未寫入日誌或儲存空間。
- 更新一項因新增 import 受影響的測試載入方式；修正既有預約公告測試仍指向 loader、未指向實際 core 模組的過期路徑。

## 執行與測試

從 repository 根目錄使用 Node.js 24：

```bash
npm ci --prefix MemberWebsocket-dev/tests/integration --ignore-scripts --no-audit --no-fund
node --test MemberWebsocket-dev/tests/*.test.js MemberWebsocket-dev/tests/integration/dialog_accessibility.cjs
node MemberWebsocket-dev/tests/integration/booking_ui.cjs
deno check MemberWebsocket-dev/supabase/functions/*/index.ts
```

自動化測試涵蓋：合法與邊界 UTF-8、空內容、錯誤 JSON、null／陣列／純量、缺少及偽造 Content-Length、超量串流取消、逾時取消、十個 API 在驗證身分前拒絕不合法內容、身分隔離、訂閱清理、彈窗鍵盤操作，以及既有會員／管理員權限與預約修改流程。

## 待完成的驗收與安全邊界

本次未連接真實 Supabase 資料庫，未變更線上資料、權限或部署設定。Repository 中的 migrations 有 RLS 與僅授權 service_role 執行的設定，但不能據此證明線上設定已套用。需在 DEV 專案確認匿名／一般會員無法直接讀取會員個資、預約或呼叫管理 RPC。

本機預覽受到本次雲端瀏覽器存取限制。JSDOM 焦點測試模擬可見性，不具有排版引擎；不代表實機、視覺、LINE 登入或整體 WCAG 驗收完成。

手動驗收矩陣：

| 情境 | 驗證項目 |
| --- | --- |
| 320、375、430 CSS px 手機 | 七頁無非預期橫向捲動；長姓名、錯誤提示與按鈕文字不截斷 |
| 768、1024 CSS px 平板；1280、1920 桌機 | 管理表格、操作區與彈窗不互相遮擋 |
| 手機橫向、iOS Safari、Android Chrome、LINE 內建瀏覽器 | 地址列伸縮、鍵盤出現時仍可捲動至確認／取消按鈕 |
| 200%／400% 縮放及減少動態效果 | 主要內容可閱讀操作；無非必要重複動畫 |
| 純鍵盤、巢狀彈窗、送出中 | 焦點停在最上層；關閉後返回適當位置；交易送出中原有鎖定仍有效 |
| DEV 測試帳號 | LINE 登入、停用會員、未授權管理員、他人預約 ID、重複兌換、斷網與重新連線 |

前端仍使用既有 LIFF 與 Supabase CDN 載入方式；完整供應鏈固定版本／完整性驗證、HTTP 層防嵌入策略與線上 RLS advisors 不在這次已驗證範圍。若要設定 `frame-ancestors`，須透過 HTTP response header，並先確認 LINE 容器需求，不能依靠 meta CSP。

## 部署順序

1. 審查 PR 與上述測試結果，完成 DEV 裝置驗收。
2. 依既有 DEV 流程部署本次修改的十個 Edge Functions，**包含其共用 `_shared/request-body.ts` 相依檔**；只貼上 index.ts 不足以部署。
3. 發布前端同一組 HTML、common.js、responsive.css、dialog-accessibility.js；保留更新後的資源版本參數。
4. 使用 DEV 測試帳號驗證登入、查詢、預約修改與權限拒絕，再決定合併與後續上線。

本次沿用既有 LINE ID token 伺服器驗證與管理員授權，不以瀏覽器傳入的 clientType 當作授權。Supabase 官方指出服務端高權限 client 會繞過 RLS，因此 API 授權與線上資料庫權限仍須各自驗證：[Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)。版本變動參考：[Supabase Changelog](https://supabase.com/changelog)。
