# Member Activity Subfilters Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this small change inline. User instructions authorize ordinary implementation details without repeated confirmation.

**Goal:** 在既有會員歷程主分類下加入可靠的細分類與筆數。
**Architecture:** 原 API 回應在前端依既有欄位分類，未知值保留在其他；不新增服務、依賴或查詢。
**Tech Stack:** 原生 JavaScript / HTML / CSS、Node test、Playwright Chromium。
**Spec:** docs/superpowers/specs/2026-11-17-member-activity-subfilters-design.md

## Global Constraints
- 僅從 Integrated-Marketing-Platform 開發；不操作正式設定／資料／master。
- 所有紀錄保留、分類互斥、切換篩選零額外歷程請求。
- 必要檢查未執行／跳過／失敗不計通過。

## Review Focus
- 新增或空的 enum 值不可以被當作已知類型。
- 取消申請不得把已完成／已取消預約重新分類為待處理。
- 即時回應不得清除合法細分類；換會員不得殘留舊資料。
- 日期無效時排序穩定；每類都遵守最新優先。
- 標籤使用 textContent；手機選單不超出畫面。

### Task 1: 分類、畫面與完整驗證
**Files:** admin/app.js、admin/index.html、admin/member-workspace-tabs.css；Node 與 browser 測試。
**Interfaces:** 消費既有 records 回應；產出 memberRecordSubcategory(record, category) 與畫面細分類行為。
- [x] 先新增行為與桌機／手機測試，對基線執行並確認預期 RED。
- [x] 實作分類、筆數、篩選重設／保留與空狀態，更新資產版本。
- [ ] 執行新增與相鄰測試取得 GREEN，執行完整 Node、整合、瀏覽器與建置；必要 CI 以最終 SHA 取證。
- [ ] 審查全差異、相同條件效能比較、提交獨立工作分支並開發 PR；全部 Gate 通過才發布開發環境。

## Progress
- 基線 Node：1531 pass / 0 fail / 0 skip。
- Ruling: 本次「細分」採既有欄位分類，不新增歷史事件帳本；這是可回復的 UI 實作判斷。

- Final review: fresh read-only reviewer identified unknown presence text; test reproduced it, then fixed (8/8 focused Node pass).
- Final: fixed source labels: grant+booking/calendar_bonus details now agree with subtype badge.
- Final: Ruling: treat invalid-date epoch fallback as part of the sorting invariant; use negative infinity and cover all five categories, pre-epoch timestamps, equal dates and multiple invalid dates. The change only affects malformed historical timestamps.
- Final: Ruling: deployment/full-CI/external-services and unchanged auth/RLS were not exercised by the reviewer; required final-SHA CI and development smoke supply those results, and fixture browser results do not claim real LINE login.
- Local broad scripts: 204 pass / 1 external retired-production-API probe timeout; no assertions removed or weakened. Same test remains mandatory in GitHub CI.
