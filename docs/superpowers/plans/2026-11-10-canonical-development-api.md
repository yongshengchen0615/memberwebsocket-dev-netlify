# 正式開發 API 統一與程式碼審查

## 基線、範圍與決策

- 來源／目標：`Integrated-Marketing-Platform`，基準 `2c40df2ce689a3186192b2145f96cd29ad0a377d`；使用獨立修正分支與 PR。
- 已確認：`config.json` 指向 `dbuquirnaskrwcamdxki` 正式開發 API；預約的三個傳輸層仍接受 preview 開關；建置只在特定分支清除舊設定。
- 已確認：五個 QA 端點已有退役 manifest；線上 `test-mode-api` 已是無資料存取的 410 handler。其餘端點仍需逐一驗證。
- 工作假設：開發規範以現有 `AGENTS.md` 與 `DEVELOPMENT_GUARDRAILS.md` 補充可執行規則，不另造流程。
- 不變條件：現有 LINE 身分、商家歸屬、價格確認、交易與錯誤語意不變；不修改資料庫、不對會員資料作破壞性測試。
- 比較：只改 config 無法阻止舊設定重啟分流；移除傳輸層分流並在所有建置清除舊值可完整解決，且不需新增依賴或架構。採後者。
- 歷史 QA 原始碼仍為既有測試的輸入；不得把歷史實作當成可上線服務。線上退役以無權限、無副作用的 410 回應或已確認的 404 為證據。

## 驗收與影響矩陣

| 編號 | Given / When / Then | 修改範圍與驗證 |
|---|---|---|
| AC-001 | Given 舊 preview 設定，When 會員預約／收據／活動／個資／presence 請求，Then 只送至正式開發 API，payload 與撤權處理不變 | `booking/common.js`；實際傳輸邊界測試、連線回歸 |
| AC-002 | Given 舊多人預約開關，When 載入、查時段、建立或更新多人預約，Then 使用正式 group API，寫入不自動重送 | `booking/group-booking.js`；傳輸與錯誤案例 |
| AC-003 | Given 舊管理端開關，When 呼叫預約管理服務，Then 使用對應正式 API，保留錯誤與商家 payload | `admin/booking-panel-core.js`；管理傳輸案例 |
| AC-004 | Given 任意建置環境與舊設定，When 建置，Then 不輸出 preview 覆寫設定；保留原 LIFF、專案及功能開關語意 | `scripts/preview-member-runtime.mjs`；所有環境與不變性測試 |
| AC-005 | Given 發布產物，When 執行建置與回歸，Then 不含測試 API 呼叫與可重啟 preview 的程式；保留隔離測試 | build/deploy contracts；完整既有 CI |
| AC-006 | Given 歷史 QA／preview 線上入口，When 驗證退役，Then 無資料副作用且拒絕請求；未驗證入口不得記為完成 | 既有 QA manifest、線上部署盤點與非破壞性 smoke；未發布前保持待辦 |

## 執行順序與測試

1. 盤點現況，先跑基準 regression，記錄既存失敗。
2. 新增／更新實際傳輸測試，執行 RED，確認舊 preview 路由可重現。
3. 最小修改三個傳輸層與建置設定清理；更新資產快取版本。
4. 補充開發規範：API 單一路由、退役證據、禁止 blanket deploy 歷史 QA、同 SHA CI 與環境證據。
5. 執行相關測試、所有 regression、scripts、語法、正式建置；依既有 workflow 執行 DOM、PostgreSQL、Chromium、Edge、dependency audit。受阻不算通過。
6. 以修改前後同環境的公開 JS bytes 比較大小；不宣稱未量測的 API 延遲提升。
7. 提交 PR，核實同 SHA 所有必要 CI；任一必要檢查失敗／受阻則不合併或發布。部署與刪除線上入口需先核實消費端及回復點。

## 回復

回復本 PR 的程式提交後重跑完整 CI 與指定開發部署；不恢復可操作的 QA API、不變更會員資料。原版本與部署 ID 在交付記錄中保留。
