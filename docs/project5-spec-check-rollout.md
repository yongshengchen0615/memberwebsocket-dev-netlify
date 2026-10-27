# Project #5「規範確認」同步上線

本 PR 僅修改 main 的 Status 同步程式、選項與測試，沒有產品程式或部署。main 與 Integrated-Marketing-Platform 是不同用途分支，不能整支互相覆寫。

## 合併前置條件

此 PR 先保持 Draft，直到有權限的 GitHub Project #5 編輯者在原 Status 欄位新增「規範確認」，位置為待規劃與準備開始之間，並實際讀回。保留其餘九項的 option identity、所有卡片及其他欄位，不重建 Status 欄位。原九項總計仍存在，新增後共十項。

新增選項後，核對此候選最終 SHA 的 CI/審查，再合併本 PR。新的 health check 要求十項，不能在 Project 僅有九項時宣稱健康或先上線。

## 實際驗證

1. 執行 `node --test scripts/project-v2-status.test.mjs`，確認原九項、新手動請求、新 label、衝突拒絕、缺新選項健康檢查、權限/回讀/重送/併發等案例全通過。
2. 合併後由既有 Project health check 讀回 optionCount=10；只讀檢查不得寫入。
3. 對確實正在做規範確認的一張既有開發卡，僅保留 `project-status/spec-check` 一個狀態標籤，讓既有 workflow 執行。讀回正確 item 的 `to=規範確認` 及 success 才算移卡完成。
4. 不測試或變更已完成/部署中的卡；此 label 不授權部署或結案，也不代表 DoR/QA 已通過。

## 規範與強制保護

每次開發的 DoR、舊功能回歸、安全負向及詳細測試由 #56 與 repo 開發規則定義。GitHub 欄位本身不限制手動移卡/合併；PR #131 的文字欄位檢查亦不能代替真實 CI、安全審查。必須另在整合分支啟用 required PR/review/checks 並核實拒絕效果，才可宣稱強制。

## 回復

先將規範確認內的卡移回有證據支持的既有 Status，再回復本 PR 的程式/測試/choice；舊 updater 接受原九項且容許其他額外選項。新選項如需移除，先核實沒有卡引用，不能直接刪除有資料的欄位或重建選項。不要覆寫其他人的 main 後續提交。
