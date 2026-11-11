# 分支與 Supabase 環境對應

使用者確認：Integrated-Marketing-Platform 連接 MemberWebsocket-test（bmwhojszsnxliekkhrka）；master 連接 MemberWebsocket-main（dbuquirnaskrwcamdxki）。測試分支不得回退正式 URL／公開金鑰／圖片來源。既有 API 名稱與伺服器授權不變，正式會員、Auth 帳號、Storage 物件、LINE 秘密與通知排程不複製。

採用現有 Netlify 與 GitHub CI：在 build 時依確切分支選擇環境，使用各專案公開 publishable key，將 runtime config 與 CSP 來源一併改寫。兩分支可共用同一程式 tree，避免依賴各站台手動變數。相較分支各維護一份 config，這個最小方案可在建置合約測試中重現錯誤分流。

正式發布僅由 master 的 GitHub Actions 於同 SHA 完整 CI 後執行；停止 develop 自動發布，阻擋未經 CI 的原生 master 建置。測試仍沿用 Integrated 原生 branch deployment 與既有 exact-SHA gate。測試後端先完成 schema-only 匯入、權限比對與 active Edge Functions，再發布指向它的前端。

AC-001：Given 整合分支，When 建置，Then 所有 Supabase runtime URL 與公開金鑰屬於測試專案，產物無正式 project ref。
AC-002：Given master，When 建置，Then runtime URL 與公開金鑰屬於正式專案，產物無測試 project ref。
AC-003：Given 大小寫錯誤或整合分支錯誤 production 身分，When 建置，Then 拒絕，不能回退正式設定。
AC-004：Given 測試資料庫，When 查詢結構／權限／資料，Then 與已審核來源相符且不含正式會員或秘密。
AC-005：Given 測試前端，When 真實瀏覽器載入與 API 請求，Then 只連測試專案；未登入、跨帳號與錯誤金鑰保持拒絕。
AC-006：Given 發布，When 必要 CI 失敗或未完成，Then 不發布正式 master。
AC-007：Given 最終版本，When 執行全部既有基線，Then 所有必要層實際成功；真實 LINE 登入需要獨立測試設定，未配置前不宣稱通過。

回復以前一個已驗證的 Netlify deploy／來源 SHA 為準，回復測試端點不得改指正式。效能不作提升宣稱：只改建置選擇與發布組態，沒有新增執行期查詢。

## CI 瀏覽器環境修復

兩次 CI 實際失敗均為 Ubuntu mirror DNS 解析失敗，瀏覽器案例尚未啟動。比較「繼續在 runner 下載系統套件」與「使用含瀏覽器及依賴的官方容器」後，採後者：版本與既有 Playwright 1.56.1 相符，固定官方 MCR manifest digest，保留全部測試、資料庫 fixtures 與斷言，不增加測試重試。容器採非 root 使用者與獨立 shared memory；預覽發布的 gh／Netlify 指令仍在 host 執行，只有唯讀 Chromium smoke 放入容器，僅掛載 browser 測試目錄並傳入公開 URL、提交識別與 CI 旗標。

AC-009：Given 瀏覽器 SDK 版本固定，When 執行三條瀏覽器測試／驗收流程，Then 使用相符且 digest 固定的官方 runtime，能實際啟動 Chromium，不再以 APT 安裝成功與否決定能否開始測試。這是 CI 環境調整，不宣稱產品執行期效能提升。
