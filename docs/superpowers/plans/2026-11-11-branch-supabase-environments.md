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
- [ ] 分批匯入到固定測試 project ref，開放 schema 前比對物件、ACL、零資料。
- [ ] 部署明確 active Edge Functions；不部署歷史 QA handler。

### Task 2: 分支建置與發布
- [ ] 新增失敗測試：整合／master 產物、混淆身分與實際 URL 選擇。
- [ ] 最小修改 runtime mapping、CSP、master 發布來源與全 CI 門檻；相鄰合約測試改以新需求為依據。
- [ ] 執行 scripts 全套與既有產品基線，建立 PR 與獨立審查。

### Task 3: 真實部署驗收
- [ ] 測試 API、DB、公開頁面與 Chromium 請求確認 project ref、授權拒絕及資料結果。
- [ ] 同 SHA 三條完整 CI 通過後合併兩個目標分支，核對 deploy ID／SHA／config。
- [ ] 交付實際測試數據、未配置外部服務與回復點，不將未執行項計為通過。
