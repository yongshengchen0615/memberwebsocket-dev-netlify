# 分支與 Supabase 環境 Implementation Plan

> 本輪由目前代理依序實作，使用獨立唯讀審查與完整既有 CI。

**Goal:** 完成指定兩分支的資料庫連接，測試專案可實際連線。
**Architecture:** 共用程式在 build 時選擇明確環境；測試後端獨立初始化與部署；正式發布保留完整 CI gate。
**Tech Stack:** Node 24、GitHub Actions、Netlify、Supabase Postgres 17／Deno Edge。
**Spec:** ../specs/2026-11-11-branch-supabase-environments-design.md

## Global Constraints
不複製正式會員、帳號、物件、秘密與 cron jobs；不變更正式資料庫；保留 canonical API 名稱與所有既有權限。

## Review Focus
整合分支不得回退正式；CSP 圖片來源同屬環境；新舊 override 不能選另一專案；master 只在完整 CI 後發布；空資料庫正常無資料與 DB 錯誤須區分。

### Task 1: 隔離測試架構
- [x] 來源 metadata 匯出、目標空結構確認；generator 失敗測試後修復 name[]、default ACL 與票券連結。
- [x] 獨立審查，4 項 generator 測試通過。
- [x] 分批匯入到固定測試 project ref，開放 schema 前比對物件與零正式資料；套用使用者明確核准的縮減 ACL，排除13個重置函式。
- [x] 部署28個明確 active Edge Functions；不部署歷史 QA handler。

### Task 2: 分支建置與發布
- [ ] 新增失敗測試：整合／master 產物、混淆身分與實際 URL 選擇。
- [ ] 最小修改 runtime mapping、CSP、master 發布來源與全 CI 門檻；相鄰合約測試改以新需求為依據。
- [ ] 執行 scripts 全套與既有產品基線，建立 PR 與獨立審查。

### Task 3: 真實部署驗收
- [ ] 測試 API、DB、公開頁面與 Chromium 請求確認 project ref、授權拒絕及資料結果。
- [ ] 同 SHA 三條完整 CI 通過後合併兩個目標分支，核對 deploy ID／SHA／config。
- [ ] 交付實際測試數據、未配置外部服務與回復點，不將未執行項計為通過。

### Task 4: 解除 CI 系統依賴下載阻礙
- [x] 核對兩次遠端日誌，確認失敗在 APT DNS，而非瀏覽器斷言。
- [x] 固定與 SDK 相符的官方 Playwright runtime；三項相容性案例先 RED，再 GREEN；本機完整1639項通過。
- [ ] 最終 SHA 的完整三條產品 CI、獨立審查及實際發布驗收。
- [x] 找出 push DOM 工作8分鐘容量不足；保留原14個命令與96個fixture，拆為core/extended平行工作，每組維持8分鐘。

目前 test 的 API 10/10、合成 DB 讀寫與回復、WSS heartbeat、五項自訂環境變數及獨立 Vault 金鑰已驗證。三項 Twilio 值依使用者要求保留空白，實際 OTP 驗收待填值後進行。
