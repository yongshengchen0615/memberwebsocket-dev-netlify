# 會員端功能開通同步修復計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 商家未開通的功能不出現在會員端，也不能由殘留選擇送出操作。

**Architecture:** 沿用 BusinessContext 的公開商家設定及既有 authenticated revision 同步；revision 改變時先重讀公開 grants，再刷新會員資料。沿用既有後端 business-policy 拒絕未授權操作，不新增資料表、套件、輪詢器或 Edge 部署。

**Tech Stack:** 原生 JavaScript、JSDOM、Playwright、現有 Supabase API。

**Spec:** 本次使用者需求、AGENTS.md、docs/DEVELOPMENT_GUARDRAILS.md。

## Global Constraints

- 基準／目標：Integrated-Marketing-Platform `930953d8463ec0373122757217fb3eda3bc84c31`；獨立 fix/member-feature-grant-sync-20261107。
- 已確認：configure 只首次取得 features，既有 revision 已包含 grants signature；後端拒絕並過濾未授權票券。
- 不變條件：LINE 身分、租戶隔離、歷史點數／票券、預留／核銷及通知對象不變。
- 狀態：開通→可見／可選；撤權→不可見／不可送出；重新開通→重新載入可用權益。
- 資料：只清除本頁失效的選擇，不改既存交易。快照照片及預約草稿保留。
- 工作假設：沿用已授權開發 Preview 流程；不發布 Production。
- 無 DB/認證架構變更，新增 migration／密碼流程不適用；完整現有 CI 含 PG/安全回歸仍必跑。

## Review Focus

- 已選票券在撤權後不可由隱藏 checkbox 或快取再次送出。
- 延遲回應不可重建已撤權票券；重新開通必須可恢復。
- 只有 points、只有 events、只有 calendar、全部關閉，各種文案／摘要不殘留其他模組。
- 主功能遭撤權時當前頁與開啟中 dialog 不可操作；背景及離線維持原同步節奏。
- 未帶 business 的舊入口維持原行為；其他商家的 grants 不得套用。

## 驗收與影響矩陣

| AC | Given / When / Then | 路徑與測試 |
|---|---|---|
| AC-001 | Given booking 開通且 points 關閉，When 一般／快照預約，Then 集點卡、扣點、獎勵提示與選擇不出現。 | business-context、booking benefits/accessibility/receipt/group；DOM/Chromium |
| AC-002 | Given events 關閉，When 開啟票券區／確認摘要，Then 只顯示獲准種類；points/events/calendar 全關則整區隱藏。 | booking HTML、確認摘要、snapshot modal；DOM/Chromium |
| AC-003 | Given 會員頁已開且已選票券，When revision 變化／恢復前景，Then 先更新 grants，失效選擇清除且不送出；重新開通恢復。 | BusinessContext.refresh、MemberSystem/BookingSystem revision callback；DOM/Chromium |
| AC-004 | Given 直接請求或跨店與撤權，When API 操作，Then 原後端拒絕且交易不變；legacy 入口相容。 | business-policy、feature-dependencies PG、既有完整 CI |

### Task 1: 共用開通狀態與會員端 gate

Files: business-context.js、member-system.js、booking/common.js；tests/integration/feature_dependencies.cjs。
Interface: BusinessContext.refresh(config) 重讀不帶 feature 的公開設定；allows(feature)、allowsBenefit(kind) 查詢當前頁 grants。

- [ ] 新增失敗測試：初始關閉、動態節點、撤除與恢復、嚴格 boolean、legacy、錯店回應、失敗保留已知狀態。
- [ ] 執行 DOM 測試取得 RED。
- [ ] 共用隱藏/inert gate，refresh 在 revision 改變與 FEATURE_DISABLED 時呼叫；無新增探測 timer。
- [ ] 重跑相關測試，記錄公開設定呼叫次數與新增資產 bytes。

### Task 2: 預約及快照完整畫面與選擇同步

Files: booking/index.html、booking-benefits.js、booking-accessible.js、booking-receipt.js、app.js、group-booking.js；會員跨模組入口。

- [ ] 新增失敗測試：points/events 分離、全部關閉、已選撤權、延遲回應與 snapshot payload。
- [ ] 以現有 helper 過濾票券、選擇、獎勵與摘要；分段文案只顯示獲准模組。
- [ ] Chromium 390/1280 實測初始／動態／dialog 與恢復，保留草稿。
- [ ] 更新修改資產 query，保持既有固定版本契約。

### Task 3: 全基線、審查與開發 Preview

- [ ] 跑全部 Node、DOM、PG17、Chromium、syntax、Edge、wiring、audit、aggregate、Netlify build、ticket policy。
- [ ] 審查最小方案、資安／資料邊界與效能比較；失敗先修復再跑最終版。
- [ ] 建立 PR，精確綁定最終 SHA 的完整 CI；通過後按已授權 IMP 開發發布範圍處理。
- [ ] 記錄 deploy ID／SHA 與 smoke；未跑或受阻不得算通過。

回復：revert 本 PR 並重新跑同版 CI／branch deploy；無 DB／歷史交易回復。

基線實測：Node 1328 pass / 0 fail / 0 skip；其他層尚未執行，不能當通過。
