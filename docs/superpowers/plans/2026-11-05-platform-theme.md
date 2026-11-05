# 總管理員亮暗色 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this small, existing-theme correction task-by-task.

**Goal:** 總管理員入口沿用現有亮暗色偏好，卡片、表單及彈窗可讀。
**Architecture:** 載入既有 theme.css/theme.js，在平台頁提供既有 .account-menu 掛載點；platform.css 使用語意色票與原色 fallback，保留未載入共用主題的舊管理入口。
**Tech Stack:** 靜態 HTML/CSS、既有主題控制器、Node test、Chromium Playwright。
**Spec:** 本文的 AC 與範圍即小修設計。

## Global Constraints

- 基準：Integrated-Marketing-Platform / 4d633bc4112474d19159cb8f9574484eb564eb7b。
- 僅調整總管理員畫面；不新增依賴、DB、授權、LINE 或審核流程。
- 保留 theme.js 的儲存、裝置偏好、分頁同步及 storage 失敗處理。
- 不修改共用主題控制器，避免改變其他入口。
- 全部既有 CI 必須成功，才可交付為已驗證完成。

## 設計與第一性原理

| 項目 | 事實／決策 |
|---|---|
| 目標 | 總管理員可用亮色及暗色，選擇可保存 |
| 根因 | platform/index.html 未載入共用主題，platform.css 大量固定亮色色碼 |
| 身分／權限 | 既有 LINE 與後端權限驗證；本輪不改 |
| 狀態／資料 | 僅沿用瀏覽器 lumen-color-theme-v1；不新增資料結構 |
| 方案比較 | 採共用現有控制器及色票；獨立平台主題會重複偏好邏輯，故不採 |
| 限制 | Project #5 讀取 403；不得假稱看板更新成功；正式外部服務未另行實測 |
| 工作假設 | 「調整」指補齊與其他管理頁一致的亮暗色支援，保留現有排版與業務 |

## 驗收與測試對照

| AC | Given / When / Then | 測試 |
|---|---|---|
| AC-001 | Given 無偏好，When 載入／裝置變化，Then 跟隨裝置；When 手動切換，Then 重載保留、分頁同步 | platform-theme.spec.cjs |
| AC-002 | Given 亮／暗主題，When 顯示商家、空狀態、期限與審核彈窗，Then 無固定白底深字失配且文字對比至少 4.5:1 | platform-theme.spec.cjs |
| AC-003 | Given 桌機／手機，When 切換與鍵盤操作，Then 按鈕可操作且無水平溢出；伺服器拒絕時不能看到工作區 | platform-theme.spec.cjs、既有平台與同步案例 |

## Review Focus

- 未登入與權限未核准時外觀控制仍可用，工作區仍隱藏。
- 日期／唯讀欄位、radio 選取與 disabled 按鈕使用正確的主題。
- 手機長商家名稱及彈窗不超出視窗。
- 舊商家頁只載入 platform.css 時仍使用原本 fallback 配色。
- 切換外觀不新增業務 API 或清除商家資料。

### Task 1: 平台主題整合

**Files:** platform/index.html、platform/platform.css、tests/browser/platform-theme.spec.cjs（均位於 MemberWebsocket-dev）。
**Interfaces:** 消費既有 theme.js 的 .account-menu 與 LumenTheme，不改其介面。

- [ ] 建立 Chromium 行為測試；先確認缺少主題控制會失敗。
- [ ] 載入共用主題與 theme-color；建立獨立於授權顯示狀態的外觀掛載點。
- [ ] 將固定亮色替換成有原色 fallback 的語意 token，補平台範圍焦點與手機控制樣式。
- [ ] 跑新增測試、既有平台／LINE 主題及同步回歸；讀取截圖。
- [ ] 比較同一建置條件下 HTML/CSS/JS 原始及 gzip bytes；不宣稱未量測的提速。
- [ ] 提交、建立 PR；核對最終 SHA 全部既有 CI、建置及必要煙霧測試。

## 執行紀錄

- 基準 Node 回歸：1287 pass / 0 fail / 0 skip，exit 0（2026-11-05）。
- 其餘結果以最終提交 CI 與交付報告為準。
