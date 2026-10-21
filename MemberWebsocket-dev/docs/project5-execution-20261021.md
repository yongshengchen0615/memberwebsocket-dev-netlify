# Project #5 執行與發布批次（2026-10-21）

## 本輪界線與第一性原理
目標是先解除 P0 發布阻擋，再按安全、資料、功能驗收排序。來源基線 `caef602d63b02996441176880ce5699743ceee6f`；目標分支 `Integrated-Marketing-Platform`。本批只修改發布工具、CI 觸發與測試，不新增業務規則、不變更資料庫、LINE 憑證或正式資料。

核心不變條件：每一必需 workflow 在相同 SHA 的最新執行必須成功；缺少、執行中、失敗、取消及跳過均不能發布。Preview 與 Production 分開，Preview 成功不代表外部 LINE、Storage 或全產品已驗收。

已確認：PR #55 已修復測試圖磚引起的 PLATFORM_APPLY 導覽逾時；SHA `3d52bcd4` 全套 CI 成功。該版 Preview 發布後 smoke 曾收到未定位 URL 的 HTTP 500。日誌不足以證明 500 根因；本次不聲稱已修復 Netlify 內部故障。Netlify request logs 工具查詢亦失敗。

已重現的發布邏輯缺口：舊 gate 先尋找任何成功 run，可能忽略較新失敗或未完成重跑；只修改 scripts／發布 workflow 時，必需 ticket-policy workflow 的 path filters 不會觸發。

## 驗收與測試
| AC | 可觀察結果 | 自動化 |
|---|---|---|
| AC-001 | 三個必需 workflow 以路徑、精確 SHA、最新 run 判斷；新版失敗／pending 不被舊成功遮蔽 | scripts/check-preview-ci.test.mjs |
| AC-002 | 九個公開頁面及五個資產符合實際發布 bundle 的 SHA-256；舊 HTML、同 SHA 不同 build、錯資產拒絕 | scripts/verify-platform-preview.test.mjs |
| AC-003 | HTTP／傳輸失敗保留網址、狀態、request ID、次數與耗時；靜態資源最多三次嚴格驗證，持續錯誤失敗 | scripts/verify-platform-preview.test.mjs |
| AC-004 | 根入口／舊 platform 連結維持轉址；API OPTIONS 204、POST 無 token 為401／AUTH_REQUIRED，CORS／no-store 正確；API 不重試 | scripts/verify-platform-preview.test.mjs |
| AC-005 | 發布相關變更觸發三個必需 workflow，保留原全套九 lane | scripts/netlify-publish-workflow.test.mjs + GitHub Actions |
| AC-006 | 發布前保存精確 bundle，成功／失敗均保存部署 ID、來源 SHA 與 smoke JSON | Preview workflow artifact + 真實發布 |

先執行新增測試 RED，再實作 GREEN。原專案 Node 回歸盤點為997通過、0失敗／跳過。局部GREEN不代替最終完整CI；實際提交、CI與發布結果更新於 Issues #33、#40及PR，未完成不能標Done。

完整基線：Test MemberWebsocket Dev（regression、DOM/SQL integration、PostgreSQL17、Chromium、syntax、Deno、wiring、audit、aggregate）、Test Netlify build、Ticket Policy UI。沿用隔離fixture；不向真實會員發送測試訊息。資料庫schema／業務程式未改，新增schema遷移與正式資料測試不適用；既有PostgreSQL與Edge基線仍須執行。

## 25張工作卡的排序與建議區塊

GitHub connector 沒有 Projects v2 field/item 能力；下表是要寫入看板的配置，不是看板實際狀態。Issue #39 為常設索引，不算第26張執行卡；開放PR保留其原狀態，沒有批次關閉。

| 次序 | 卡片 | 優先級 | 建議 Status | 下一個可驗證動作 |
|---|---|---|---|---|
| 01 | #40 | P0 | In Progress | 修正最新 CI 選取、缺失觸發器、逐資源版本與 HTTP 診斷；PR → 全套 CI → Preview smoke |
| 02 | #34 | P0 | Ready | 逐入口建立認證／角色／租戶矩陣，以合成 A/B 帳號驗證拒絕路徑 |
| 03 | #33 | P0 | In Progress | 落實同 SHA 證據與 Preview 發布；Production 保留獨立版本、備份、審查及驗收 |
| 04 | #48 | P1 | Ready | 盤點現有本機 PostgreSQL／PGlite 與外部 LINE、Storage 資源，建立正式環境拒絕清理規則 |
| 05 | #35 | P1 | Ready | 固定遠端時間及來源 SHA，逐版本比對 history；不要用數量差直接判定 drift |
| 06 | #53 | P1 | Backlog | 建立新舊商家模板版本 fixture，測增量升級、回復、權限及資料保存 |
| 07 | #47 | P1 | Ready | 建立需求→AC→案例→命令→SHA→證據矩陣，將 Provider 未驗與 CI 成功分開 |
| 08 | #56 | P1 | Code Review | 審查既有 PR #57 及同 SHA CI，不重做治理文件；核實 required checks 的實際強制效果 |
| 09 | #31 | P1 | Ready | 核對已合併事件修復與遠端 tenant RPC／outbox；確認後再決定是否需要程式變更 |
| 10 | #36 | P1 | Blocked | 備妥兩個不同 LINE 身分、Channel／LIFF 路由後驗證雙向通知；不以同帳號或 accepted 取代收件 |
| 11 | #59 | P1 | Ready | 先檢查既有 LINE 分頁，逐步優化模組狀態、設定引導、草稿與角色收件文案 |
| 12 | #60 | P1 | Ready | 優化既有停用／啟用政策摘要、撤銷誤判／解除／回覆的安全操作；保留原政策 |
| 13 | #41 | P1 | Backlog | 執行合成 root→申請→核准→模組設定→會員使用→撤權的三端 E2E |
| 14 | #42 | P1 | Backlog | 以真實隔離 PostgreSQL 驗證餘額、預留、轉贈、核銷與併發最終守恆 |
| 15 | #43 | P1 | Backlog | 驗證建立→確認→有效修改→取消／完成／未到店及預留／通知資料一致 |
| 16 | #49 | P1 | Backlog | 驗證入會條款、資料所有權、帳號切換、停權與敏感資料移除邊界 |
| 17 | #50 | P1 | Backlog | 測活動與固定票券配額、日曆檔期、階級限制、併發領取與重複核銷 |
| 18 | #51 | P1 | Backlog | 驗證好友、推薦、QR 與代約結算歸屬，測取消／完成重試不重複獎勵 |
| 19 | #52 | P1 | Backlog | 以 stub 先驗佇列租約、重試與商家隔離；再接真實 Provider 故障／恢復證據 |
| 20 | #37 | P1 | Backlog | 驗簽署上傳、跨商家拒絕、核銷、清理及中斷恢復，不重設正式 bucket |
| 21 | #44 | P1 | Backlog | 驗證雙分頁、離線／503／重連、舊快取與版本混用後的資料一致性 |
| 22 | #46 | P1 | Blocked | 依 #39 最新25張矩陣核對真實 item，寫入 Status／Priority 並讀回；目前只更新 Issues |
| 23 | #54 | P2 | Backlog | 驗證設定複製與草稿隔離、交易回滾、冪等；不複製會員／票券／通知歷史 |
| 24 | #45 | P2 | Backlog | 量測 390／1280、鍵盤、對比、載入與效能基線，再做最小優化 |
| 25 | #38 | P2 | Backlog | 整理 Advisors 實際嚴重度、監控與未合併 PR，不批次關閉或刪除分支 |

先後順序以可開工條件為準；Blocked 項目跳過並保留原因。#48環境盤點不依賴#35完成；#35唯讀對照也不依賴完整沙盒；#42/#43共用fixture而非形成循環依賴。#59/#60的UI工作可先做，外部服務仍須另驗。

## 執行與回復
```bash
node --test scripts/check-preview-ci.test.mjs scripts/verify-platform-preview.test.mjs scripts/netlify-publish-workflow.test.mjs
COMMIT_REF=$(git rev-parse HEAD) node scripts/build-site.mjs
COMMIT_REF=$(git rev-parse HEAD) PREVIEW_BASE_URL=https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app node scripts/verify-platform-preview.mjs
```
最後一條只適用正在驗證的dist就是實際部署bundle；重新build會產生不同版本，不可用重建產物冒充原bundle。發布workflow自動在同一workspace使用實際上傳dist驗證。報告寫入evidence/platform-preview-smoke.json（不記錄回應body、token或secret）。

部署到既有Preview alias，由完整CI gate後觸發。要修復不良發布，revert本批程式提交後重新執行完整CI和發布；不呼叫Netlify恢復舊部署API。正式Production發布、真實LINE／Storage驗收與Project欄位搬移各自仍需完成相應卡片條件。

