# 系統分配商家代碼修復計畫

> **For agentic workers:** Use superpowers:executing-plans to implement this single fix with TDD.

**Goal:** 管理員只填商家名稱；商家代碼由 API 分配。
**Architecture:** 沿用既有 merchant RPC、唯一約束與 requestId 冪等交易。新申請將 UUID 操作識別映射成 `m-` 加 32 位十六進位代碼；退回重送由 owner-scoped RPC 讀取原代碼。拒絕外部 slug，無 DB migration。
**Tech Stack:** 現有 JavaScript、Supabase Edge、PostgreSQL、JSDOM、Chromium。
**Spec:** 使用者既定需求「商家代碼由系統分配，不讓管理員自行輸入」；線上 e58d626 已重現 v2 表單及 API 仍要求 slug。

## Constraints and acceptance

- AC-CODE-001 Given 合格管理員，When 只填名稱，Then 申請 pending 且回傳唯一合法代碼。
- AC-CODE-002 Given 相同 requestId，When 遺失回應後重試，Then 同一申請、同一代碼，資料不重複。
- AC-CODE-003 Given 退回申請，When 改名重送，Then 保留代碼、版本檢查及 owner 邊界。
- AC-CODE-004 Given 自訂 slug 或錯誤身分，When 呼叫 API，Then 拒絕且不寫資料。
- AC-CODE-005 Given 已核准 A，When 申請 B，Then B 獨立 pending，A 的功能及資料不變。

## Review focus

UUID 大小寫正規化；不同 requestId；跨 owner 重送；lost-response 重播；舊頁面自訂 slug 被拒。

## Task 1: API 與表單契約同步

- [ ] 在 merchant_application_api.cjs 補上無 slug 正常／重播／不同申請／偽造代碼／保留原代碼案例；UI 測試驗證無可編輯 slug 且 payload 不含 slug，先觀察 RED。
- [ ] 修改 `_shared/platform-handler.mjs`、`platform/app.js`、`admin/workspace.html`；維持原 RPC 與 DB 約束；既有測試改為依伺服器回傳代碼定位。
- [ ] 重跑 API、DOM、Chromium 真實 handler/SQL 旅程並檢查 DB 終態。
- [ ] 完整 Node、DOM、PostgreSQL、Chromium、Edge、靜態、build、audit CI 以最終 SHA 驗證；部署 Edge 時保留原 verify_jwt。
- [ ] 發布整合分支並確認 Netlify SHA；用已登入瀏覽器驗證無手填代碼欄，提供操作網址及證據。

## Recovery

無 schema／歷史資料修改；必要時 revert 本次提交並重新部署 Edge 與分支前端。
