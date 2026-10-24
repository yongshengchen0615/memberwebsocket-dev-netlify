# Project #5 本輪驗收與執行矩陣

來源基線：`Integrated-Marketing-Platform@b66ca8334b011191867234dd596c543b2c177a66`。日期：2026-10-22（台北）。本文件是可追溯的案例入口與缺口清單，不是所有 AC 已通過的聲明。最終候選 SHA 與實際結果由 PR／Actions 記錄；不得用來源基線的成功代表新候選。

## 第一性原理與本輪範圍

| 面向 | 規則 |
|---|---|
| 目標 | 管理員可用鍵盤選擇已授權 LINE 模組；爽約操作在請求期間不可重入，失敗後可保留原因並重試 |
| 身分／權限 | 沿用 LINE Provider 驗證、可信商家與伺服器角色檢查；本輪沒有變更 API、角色、功能授權、憑證或 SQL |
| 狀態 | 同一爽約元件同時最多一個請求；失敗解除鎖定，保留輸入；成功才以回應重畫紀錄 |
| 資料 | LINE 分頁切換不重建表單；原 requestId、秘密留空與通知收件方向保持原契約 |
| 限制 | 缺少核可獨立 Supabase／Storage／LINE 沙盒與真人收件證據；不可對既有 project 作 reset、seed 或破壞測試 |
| 決策 | 小範圍改現有元件，避免重建管理台；DB 與 Edge 僅唯讀盤點，保留未解差異 |

## AC → 案例 → 層級 → 命令

下列測試均沿用真實來源；外部 LINE 是明示 stub，PGlite 是隔離 SQL fixture，不能冒充真實 Provider／遠端 Supabase。

| 卡片／需求 | Given / When / Then 摘要 | 可執行證據入口 | 層級／命令 | 尚缺驗收 |
|---|---|---|---|---|
| #59 AC-LINE-UX-007 | 已授權兩模組；方向鍵／Home／End 切換；焦點、ARIA、面板一致且草稿保留，撤權模組消失 | `tests/integration/line_settings_keyboard.cjs`、`tests/browser/notification-settings.spec.cjs` | DOM：`node --test MemberWebsocket-dev/tests/integration/line_settings_keyboard.cjs`；Chromium：`npm test --prefix MemberWebsocket-dev/tests/browser -- notification-settings.spec.cjs` | 真人 LINE／WebView、完整設定狀態引導及其餘 AC |
| #60 AC-RISK-UX-004（子集） | 原因已填；動作請求中／失敗；其他動作停用，失敗後原動作可重試且原因不丟失 | `tests/integration/booking_risk_ui.cjs`、`tests/browser/booking-risk-recovery.spec.cjs` | DOM＋Chromium，套件命令同上指定 spec | 敏感操作確認、uncertain commit 的真實對帳、完整全卡 AC；本修正不宣稱新增後端冪等 |
| #60 政策／資料 | 預設停用；啟用／回覆／解除；SQL 保留原限制語意及稽核 | `tests/browser/booking-risk.spec.cjs`、`tests/integration/postgres/booking-risk.cjs` | Chromium＋PGlite；CI PostgreSQL 17 實體 session | 外部沙盒資料與 Provider |
| #64 AC-ADM-UX-001/003/006/007（既有切片） | 原導覽與捷徑可見；鍵盤／撤權／尺寸切換；操作既有面板不新增交易 | `tests/browser/admin-quick-actions.spec.cjs`、`tests/integration/product_admin_ui.cjs` | Chromium 320/390/768/1280；DOM | 完整 UX-01 導覽盤點、長文／縮放、草稿、實機與 Preview |
| #45 AC-UX-001（桌面 fixture 子集） | 三端既有頁面；尺寸／焦點／長內容；按現有斷言核對布局 | `tests/browser/ui-layout.spec.cjs`、`settings-layout.spec.cjs`、`receipt-location.spec.cjs` | 全套 Chromium baseline | iOS／Android LINE WebView、穩定 Preview 的網路量測與 before/after；不以 fixture 耗時當實機效能 |
| #45 點數轉贈焦點回歸 | 對話框開啟後會員已開始輸入；延遲任務到達；焦點仍留在輸入欄，無扣點 | `tests/integration/qa_user_journeys.cjs`、`tests/browser/points-transfer.spec.cjs` | 可控排程 DOM＋Chromium；保留原 QR／好友切換草稿斷言 | 來源候選 bc48d3c 的 push Chromium 曾 271 pass／1 fail，PR Chromium 272 pass；不可用另一 run 成功掩蓋失敗。原延遲 focus 在可控案例失敗後改為面板可見時同步聚焦，須以新候選重跑全部 CI |
| #34 AC-001/002（盤點／既有案例） | 32 入口；記錄 action literal 與驗權參照；標明尚未逐路徑驗證 | `docs/project5-edge-entrypoints-20261022.json`、`tests/edge_auth_contract.test.js`、`tests/edge_line_claims.test.js`、`tests/fixed_ticket_admin_auth.test.js` | 來源盤點＋Node handler/claims fixture | 218 個入口 action literal 不等於可達路由清單；委派 handler、SQL owner、跨商家、撤權及真實 Provider 仍待逐一追蹤 |
| #35 AC-001（唯讀版本對帳） | 固定來源與遠端時間；按版本／同名對帳；保留未解項而不 repair history | `docs/project5-migration-reconciliation-20261022.json` | Supabase list_migrations＋唯讀 SQL history；來源 Git tree | SQL 內容等價、遠端缺檔來源、fresh/upgrade/restore 全量基線與核可沙盒 |
| #47 AC-QAM-001～004（追蹤） | 來源／CI／部署／Provider 分開；失敗／skip／錯 SHA；release 不得當成功 | 本矩陣、`scripts/check-preview-ci.test.mjs`、`scripts/verify-platform-preview.test.mjs`、`scripts/netlify-publish-workflow.test.mjs` | Node＋精確 SHA Actions | 下列功能每項 AC 的完整正反向、邊界、併發與外部結果仍由各卡逐項結案 |

## 已啟用功能回歸與授權邊界

這是功能領域索引，未證明每個 action 均已覆蓋。未有可追溯案例的細項須保持缺口，不得以本表行數或測試檔存在判為完成。

| 功能／卡片 | 不變條件與負向路徑 | 現有案例入口（`MemberWebsocket-dev/`） | 外部缺口 |
|---|---|---|---|
| Platform／Admin #41 | 申請→核准→授權；未核准、撤權、跨商家拒絕 | `tests/integration/product_platform.cjs`、`admin_access_lifecycle.cjs`、`tests/browser/product-platform.spec.cjs`、`business-activation.spec.cjs` | 真實核可 A/B 帳號／Provider |
| Member #49 | 自身個資／條款；不能自改權限或看到別人資料 | `tests/integration/member_terms_startup.cjs`、`member_removal_sql.cjs`、`tests/browser/member-join-terms.spec.cjs` | 停權舊 token 與真人帳號 |
| Booking #43 | 生命週期／多人技師；取消不結算、異動不漏通知 | `tests/integration/booking_notification_events.cjs`、`booking_ticket_consistency.cjs`、`tests/browser/booking-calendar-times.spec.cjs` | 跨商家及真實收件 |
| Points／Tickets #42 | 保留、扣點、轉贈守恆；重送不重複扣發 | `tests/integration/point_ticket_multi_quantity.cjs`、`transaction_lifecycle.cjs`、`tests/browser/points-transfer.spec.cjs` | 真實隔離 multi-session 及餘額對帳 |
| Event／Calendar #50 | 資格、時區、GPS、配額；higher_preview 不可領取 | `tests/integration/event_coupon_sql.cjs`、`fixed_ticket_automation_sql.cjs`、`tests/browser/receipt-location.spec.cjs` | 真人定位與外部部署版本 |
| Friends／Referral #51 | QR 不自動結算；代約歸屬與推薦重送安全 | `tests/integration/friends_ui.cjs`、`referral_current_rule_sql.cjs`、`member_p2_features.cjs` | 核可帳號及裝置相機 |
| LINE #31/#36/#59 | 會員建立→管理員；管理員修改→會員；accepted 不等於送達 | `tests/integration/notification_routes.cjs`、`business_line_settings.cjs`、`tests/browser/notification-settings.spec.cjs` | 不同且同意測試的雙方 LINE 身分、Provider 收件時間／內容 |
| Storage #37 | 商家／物件 scope；未授權與跨商家讀寫拒絕 | `tests/integration/receipt_storage_tenant_guard.cjs`、`receipt_integrity_sql.cjs`、`tests/receipt_api_integrity.test.js` | 指定可清理 bucket/prefix、真實簽名上傳／checksum／還原 |
| Runtime／Sync #44/#52 | 重入、晚到回應、離線恢復；不重複派送或覆蓋新狀態 | `tests/integration/business-runtime.cjs`、`e2e_background_sync.cjs`、`tests/browser/business-sync.spec.cjs` | 外部 worker 故障／重啟與真實 Outbox 對帳 |
| Tenant／Copy #53/#54 | 升級資料保留、複本草稿隔離；不能複製資產與歷史 | `tests/integration/business-runtime.cjs`、`member_p2_features.cjs`、`product_admin_ui.cjs` | 核可新／舊模板沙盒與完整遷移基線 |

## 版本、CI、部署及 Provider 必須分開

1. 完整必要來源：`.github/workflows/test-memberwebsocket-dev.yml` 的 8 lanes＋aggregate，以及 `test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`；不刪除原案例或降低斷言。
2. 本輪新增 DOM spec 已加入 integration lane；新增 browser spec 由既有 `*.spec.cjs` 收集。必要失敗／跳過／取消／逾時／零案例均不能通過 gate。
3. 來源 `b66ca833` 的三條必要 push CI success；Preview run `39743453281` failure。此為開始前事實，不代表本輪新候選已測或已部署。
4. 固定票券已部署 v11 缺少來源 PR #66 的 `isVerifiedLineIdClaim`，保留部署差異；本輪未部署後端。
5. 真實 LINE／Storage、沙盒及實機驗收缺口保持未執行。不能以 Node、PGlite、Chromium stub 取代。

## 執行與回復

沿用既有 Node／npm／Deno／PostgreSQL／Chromium workflow 命令。先跑兩個 DOM spec 與受影響 browser specs，再以最終候選執行全部必要 CI。開發環境可使用工作區 `tmp` 作 TMPDIR；不改測試斷言或加入 retry。

回復採 revert 本輪小提交後重新完整 CI。無 SQL／migration／正式資料變更；不可直接修 migration history、覆寫既有 migration 或恢復舊 Netlify deploy。
