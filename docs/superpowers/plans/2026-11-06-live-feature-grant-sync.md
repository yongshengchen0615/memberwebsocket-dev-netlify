# 功能開通即時同步與跨模組畫面查漏

基線：Integrated-Marketing-Platform `9143572b1233ed9bd3079b345ae26292a7fbb305`；本輪分支 `fix/live-feature-grant-sync-20261106`。目標環境仍為已授權 Integrated-Marketing-Platform。Issue #56（回歸規範），延續 PR #206。

| 項目 | 已確認事實／決策 |
|---|---|
| 目標 | 總管理員關閉功能後，已登入的一般管理員畫面自動更新，跨功能控制項一併隱藏；重新開通恢復。 |
| 身分／權限 | 既有 LINE 身分、tenant resolver、private admin 狀態、Business Policy 繼續在伺服器驗證；前端標記不是授權來源。 |
| 狀態 | 依賴全部開通才顯示；points 或 events 任一可提供票券功能；撤除目前主分頁改選仍獲准分頁。 |
| 資料 | 隱藏/inert 保留已儲存規則及表單草稿；撤除視窗所屬模組才呼叫原關閉處理。不得重設點數規則或交易。 |
| 根因 | syncRevision 只讀 private realtime_events；控制平面 tenants.features 變更不保證新增該事件。舊前端每 120 秒強制全量刷新前可能仍沿用舊權限。原測試直接 apply 新 flags，未走完整同步路徑。 |
| 限制 | 不改資料庫、不改授權／結算／通知、不啟動既存停用排程。3 秒是健康前景探測間隔；還需加網路和 bootstrap 回應時間，不宣稱零延遲推播。 |

## 驗收與執行順序

| AC | Given / When / Then | 測試與證據 |
|---|---|---|
| AC-001 (=AC-SYNC-001/003) | Given 管理端開著預約類型視窗，When root 關閉 points，Then 原「完成服務自動集點」及其欄位無需重新整理即隱藏；不關閉預約視窗。 | feature_grant_sync.test.js、business_sync_revision.test.js、feature-grant-sync.spec.cjs（390/1280） |
| AC-002 (=AC-SYNC-002/004) | Given 任一模組和相依控制項，When 關閉任一必要模組，Then 摘要／紀錄／動態節點／獨立編輯視窗一併跟隨，伺服器仍拒絕未授權或跨店。 | feature_dependencies.cjs、notification_routes.cjs、business_policy.test.js、完整基線 |
| AC-003 (=AC-SYNC-001/004) | Given 有未儲存的類型名稱、勾選與分鐘數，When 關閉再開啟 points，Then 草稿與已儲存資料保留，控制項恢復。 | 真實 admin/MemberSystem/BusinessWorkspace + 真實 root handler/隔離 SQL；僅外部 LINE 和其他業務持久化用既有 fixture |
| AC-004 (=AC-SYNC-003/005) | Given 慢請求／背景／恢復前景／撤除目前主分頁，When 權限改變，Then 請求不重疊、背景不輪詢、恢復立即查詢、改選可用分頁，手機/桌面一致。 | business_sync_revision.test.js、feature_dependencies.cjs、feature-grant-sync.spec.cjs、business-sync.spec.cjs |

已依序完成：基線 Node 1307/1307；RED 17 案例中 4 失敗（revision、3 秒、漏標記、主分頁）；最小修復後同 17/17。最終候選仍需完整 CI，不能用開發中結果替代。

## 影響與查漏矩陣

| 修改 | 原功能／相鄰入口 | 防退化 |
|---|---|---|
| sync-revision.mjs | authenticated revision；控制平面 grants → 商家畫面 | 固定 canonical bits、只接受 literal true、維持回應一欄及原兩次 DB reads；unscoped 兼容；授權先查 |
| member-system.js | healthy admin 3 秒；會員等其他端仍 10 秒 | 無變更不全量載入；背景暫停、resume、generation、故障 backoff、unsubscribe 保留 |
| business-workspace.js | 所有五個主模組與 LINE、late-mounted 預約 | 加會員統計、fixed calendar 摘要、紀錄 summary filters、owner dialogs；共用既有依賴判斷支援動態元素屬性；主分頁 fallback |
| app.js | 會員紀錄／預約統計／設定複製視窗 | 標記對應模組；membership 單獨仍可操作服務時間；不改 API 寫入 |
| booking-panel-core.js | 類型自動集點、票券卡、結算預覽 | points/membership/benefit-kind 分別標記；多模組合計在缺少相依時隱藏以免殘留錯誤總數 |
| booking-accessible-admin.js | 快照審核／歷史／可用票券／扣點摘要 | 開啟中視窗也同步；按票券種類標記；不改選取、扣點、結算及復原流程 |
| index.html / booking-panel.js | 資產版本 | 保留原版本契約並添加 grants query，更新已審查資產 hash；保留所有既有 human journey |

## 最小方案與品質、效能

比較方案 A：在既有 authenticated opaque revision 納入可信 request context 的 canonical grant bits；方案 B：新增控制平面 Realtime channel／事件／RLS。採 A，無新依賴、DB、匿名訂閱或新授權入口，易回復。動態節點只宣告實際使用模組，沿用中央 gate；不建立新框架。不同票券種類分開，避免將 points/events 誤綁為一個功能。

同固定時鐘、60 秒前景：舊版健康探測 7 次（含 t0），新版 21 次；全量 refresh idle 仍 1 次。每次仍為既有 2 個 private DB reads。換取已開啟管理端 grant 偵測間隔由無事件時最高 120 秒全量回補，改為健康 3 秒＋網路；非 admin 的間隔不變。失敗 backoff 和背景 0 探測不變。不是免費效能提升；不宣稱尚未量測的 API p95。

## 完整驗證與發布

執行現有 `.github/workflows/test-memberwebsocket-dev.yml` 全部 Node/DOM/PostgreSQL17/Chromium 三 shard/Edge/syntax/wiring/audit/aggregate，以及 Netlify build 和 Ticket Policy；本機 Chromium runtime 受 sandbox 限制，真實 browser 結果以最終 SHA 的 Actions 為準。既有外部 LINE/簡訊支付流程本輪不新增／變更，無真實訊息測試，不能將 fixture 宣稱為真人服務驗證。

發布精確候選至 Integrated-Marketing-Platform；sync-revision 只有 api/index.ts 消費，更新共享 api 與 api-preview 的對應 bundle，保留各自 entrypoint 與其他現有檔案。無 migration、無正式會員資料變動。記錄 deploy IDs、讀回 source、未登入 401、同 SHA build/smoke。回復：revert 本 PR + 重發基線前端，Edge 使用部署前 API bundles；無資料回復／刪除步驟。

## 審查修復及瀏覽器 RED

初始候選37cf611在真實Chromium手機/桌面均重現 label 已 gate=false 仍 visible：booking-panel.css `.booking-admin-modal .booking-admin-toggle {display:flex!important}` specificity高於共用attribute gate。補上對adminView/dialog的較高 specificity，保留既有!important顯示契約並新增exact CSS browser案例。

獨立審查4項Important已修：bootstrap保存開啟中的card/ticket/event/calendar草稿（admin_startup grant-drafts先RED再GREEN）；receipt隱藏勾選不送新payload、不列入budget；busy owner由定向撤權事件強制cleanup、失效generation及清除signed image；points初始off→on局部更新類型卡片選單和即時catalog判斷。兩個receipt DOM案例實測cleanup及payload；Chromium加入初次開通。既存reservation仍受原後端fail-closed政策保護，不會因隱藏而取消/核銷資產。
