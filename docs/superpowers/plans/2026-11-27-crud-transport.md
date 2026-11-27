# CRUD Transport Implementation Plan

**Goal:** 修正寫入被合併／重試及單筆日曆儲存全量回讀。
**Architecture:** 保留 MemberSystem、現有 Edge handler 與 SQL 交易。只有已知安全讀取能共用／重試；單筆回讀以 ID 下推 DB 篩選。
**Tech Stack:** Browser JavaScript、Supabase TypeScript、Node test、Playwright、既定 CI。
**Spec:** `docs/superpowers/specs/2026-11-27-crud-transport-design.md`

## Global Constraints

- 來源／PR 目標 Integrated-Marketing-Platform；測試 ref bmwhojszsnxliekkhrka。
- 不新增依賴、schema、快取、timer 或通知；不覆寫其他 PR。
- 先 RED 再 GREEN；必要未執行檢查如實標示。

## Review Focus

- 新增、修改、刪除、未知動作的斷線與不確定結果不能重送。
- 不同 LINE 憑證／商家與 session status 不得重用舊檢查。
- 寫入前後讀取失效，晚完成的舊請求不能移除新請求。
- 單筆新增 ID 必須來自成功 SQL；查不到時不得退回全表。
- 列表／批次、授權拒絕與 DB 失敗保持既有契約。

## Tasks

1. [ ] 於既有 connection_transport_regression 測試增加 CRUD／未知動作故障、不合併與讀取失效案例；執行並保留 RED。
2. [ ] 調整 member-system.js 讀取分類；執行新測試與現有傳輸回歸。
3. [ ] 於 api_performance 增加日曆單筆與大量 fixture、錯誤／列表測試；保留 RED。調整 calendarItems 可選 ID 與 save 呼叫，驗證 GREEN。
4. [ ] 增加桌機／手機 Chromium 實際網路請求案例；同條件記錄前後請求／回讀數與 bytes。
5. [ ] 執行完整基線、build、audit、timer 與 inventory；整批 diff 審查、建立 PR 與同 SHA CI 證據；未通過不合併或發布。
