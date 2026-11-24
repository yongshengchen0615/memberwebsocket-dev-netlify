# 即時同步生命週期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 減少離開頁面後殘留連線及舊事件造成的工作，讓櫃檯恢復連線後正確補查。

**Architecture:** 在現有訂閱內追蹤 channel 世代與移除中的 Promise；不新增連線管理框架。櫃檯沿用既有 revision、單一進行中查詢與退避。

**Tech Stack:** 原生 JS、Supabase JS Realtime、Node 24、Chromium、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-24-realtime-lifecycle-design.md`

## Global Constraints

- 基準 `3e4369293ba6a3190617704cdc06a0fda340e378`，目標 `Integrated-Marketing-Platform`／MemberWebsocket-test。
- 不變更正式設定、DB、Edge、LINE 登入或寫入重試政策；保留三條完整 CI。
- 不以提高 timeout、固定 sleep、刪除測試或放寬權限換成功。

## Review Focus

- SDK 移除尚未完成時恢復，不可讓舊 channel 移除新 channel。
- 退訂、離線及 pagehide 後的晚到 status/event，不可污染新連線。
- 重複 pageshow/online 不可建立重複 channel。
- 櫃檯停用／拒絕授權後，不可繼續排程或補查。
- 商家同步維持原授權邊界；事件不可攜帶或授權另一商家資料。

### Task 1: WebSocket 與訂閱範圍

**Files:** `MemberWebsocket-dev/member-system.js`、`booking/common.js`、同步測試與 Chromium 測試。

**Interfaces:** 保留 `subscribeRealtime(...) -> unsubscribe`；內部 channel 世代與清理 Promise 不對外暴露。

- [ ] 新增退訂後事件、pagehide/offline、延遲清理、重複恢復與商家切換測試，跑出 RED。
- [ ] 最小修改兩個訂閱，移除完成前不重建；晚到回呼依世代拒絕；MemberSystem 設定不同時替換訂閱。
- [ ] 執行相關同步、安全回歸；期望全部通過，取消後零殘留 channel。
- [ ] 提交 Task 1。

### Task 2: 櫃檯同步恢復與驗證

**Files:** `MemberWebsocket-dev/frontdesk/app.js`、`tests/frontdesk_sync_lifecycle.test.js`、量測腳本與報告。

**Interfaces:** 保留 `probeSync/startSync/stopSync`；暫停讓舊世代失效，恢復只補一次。

- [ ] 新增背景／離線／恢復／停用／錯誤案例，先確認 RED。
- [ ] 修正既有排程並執行 GREEN，保持權限錯誤停止與退避。
- [ ] 同條件量測前後資源／請求數，執行完整應用、scripts、建置及三條 GitHub CI。
- [ ] 提交，獨立 review；全部必要檢查成功後合併測試分支並驗證發布 SHA 與 smoke。
