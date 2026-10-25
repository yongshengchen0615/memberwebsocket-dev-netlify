# Project #5 雙軌並行開發設計（2026-10-25）

> **狀態：建議設計／待 PR 審核**。本文件是開發治理規格，不是正式環境操作授權。對應 Epic #129，子卡 #125～#128。來源基線：`Integrated-Marketing-Platform@e58d626eaef0e189849e4a4eb759af6d4bea94dd`。

## 目的與邊界

讓會員、預約、集點、票券、LINE 與管理端功能持續交付，同時漸進整理現有 Monorepo；以回歸可追溯性優先，避免「全面搬目錄」造成路由、靜態資產、LIFF、Edge Functions 或 DB migration 失效。

**不做：** 此 PR 不移動 `MemberWebsocket-dev/`、不更改 `netlify.toml`、不合併其他 PR、不改正式 Supabase／LINE／Netlify，也不把 `main` 當作目前已生效的唯一 Production 發布來源。

## 已核實基線（2026-10-25；需在每次實作前重新查證）

| 介面 | 實際結果 | 不能推論的事 |
| --- | --- | --- |
| GitHub | Default `main@8d1b624876947e178f8fa078ddf02b4258dbb7ad`; `develop@b04486a557ae35c126531cdd1bdb15a22667be5d`; 整合分支 `e58d626eaef0e189849e4a4eb759af6d4bea94dd`；讀得三分支 `protected=false` | 不代表其他治理機制已啟用 |
| Netlify | Site `23796c62-480a-4b46-ac90-bfbc5ad4d300` 的 Production Deploy `6ad34aa232fcb1cea452346f` 為 ready；建立於 10/17，title `verified-develop-b04486a...`，`deploy_source=api`，`commit_ref=null`，branch 欄回傳 `master` | 不能從 title 或 branch 欄單獨推斷 Netlify 控制台的 Git Production Branch |
| Supabase | Project `dbuquirnaskrwcamdxki` ACTIVE_HEALTHY；查得 0 個 Database Branch；308 筆已登記 migration，整合分支 276 個 SQL migration 檔；33 個 Edge Functions | migration 數量差不能直接算成缺失或執行安全性；亦不代表已隔離 staging |
| 安全稽核 | Supabase advisor 有 `extension_in_public` WARN 1 項，以及多項 INFO | `rls_enabled_no_policy` 不必然是漏洞，需確認 schema 是否對外暴露及存取用途 |

參考現有 Issues：#33 發布準入、#34 Edge 授權、#35 migrations、#40 Preview 發布、#47 QA、#56 開發治理、#95 多 Repo 方案；已開 PR #57、#101，先檢查它們的重疊範圍，避免重工。

## 方案與決策

| 方案 | 優點 | 主要風險 | 判斷 |
| --- | --- | --- | --- |
| 停工一次重構 | 表面上可快些整理檔案 | 改動過大、回歸定位困難、延後功能 | 不選 |
| 功能、重構任意平行 | 功能速度看似最快 | 相同檔案衝突、不同來源的 API／SQL 契約互蓋 | 不選 |
| **雙軌、短生命週期分支、依序合併** | 維持功能進度，逐模組收斂技術債 | 需要衝突與驗收治理 | **採用的建議設計** |

## 模型與責任

- **A 軌 Feature：** `feat/*` / `fix/*`，一個 Issue 對應一個可獨立驗收的功能或缺陷。
- **B 軌 Architecture：** `refactor/*` / `chore/*`，先梳理依賴、測試與無行為變更的結構；涉及業務契約者必須另開變更審查。
- **整合點：** 沿用既有 `Integrated-Marketing-Platform` 驗收流程，禁止未查證就改成 `main` 或 `develop` 自動發佈。兩軌 PR **逐一合併**，每次重新驗證合併 SHA。
- **工作量：** 以功能 70%、架構 30% 為起始建議（非工時承諾）；P0 安全及發布事故優先中斷普通功能。
- **WIP：** 建議同時最多兩個程式修改中的 PR；若觸及同一共享檔案、同一 Edge function、同一 migration 契約，先定義合併順序。
- **AI 開發：** 每個工作開新分支／獨立 worktree，讀取基線、定義受影響檔案、寫 RED→GREEN 測試，再修改最小必要內容；不能跨工作區直接複製未驗證結果。

## PR 變更規模分級與自動化 Gate（#129 / #127）

**此設計在 Draft PR #131 實作，並不代表目標分支上的 Ruleset / Required Status Check 已啟用。** 風險等級是保守的路徑分析下限，人工有權提升等級，不得僅依行數或總檔案數認定安全。

| 風險等級 | 可偵測條件 | 必要處理 |
| --- | --- | --- |
| 小改 | 單一功能局部檔案，無命中跨模組或敏感路徑；純文件亦屬此類 | 依既有 PR Code Review 與對應模組測試，不豁免正式 Gate |
| 中改 | 影響兩個核心模組，或修改共用 JS／API 入口 | PR 說明須有受影響模組、測試與驗收、回退方案；跨模組回歸 |
| 大改 | 影響三個以上核心模組，或任一 Supabase migration／Edge／認證權限／Netlify／CI 工作流程等高風險路徑 | 額外要求架構審查與發布及資料庫相容性說明；拆分可驗收 PR，人工批准 |

**具體實作：** `scripts/pr-change-risk.mjs` 的 `classifyChangeSet()` 與 `evaluateEvidence()`；`scripts/pr-change-risk.test.mjs` 的 Node 單元測試；`.github/workflows/pr-change-risk.yml` 對 `pull_request`（含 edited）無 `paths` 過濾觸發；`.github/pull_request_template.md` 提供規格化欄位。

- Actions 權限只有 `contents:read` 與 `pull-requests:read`，分頁讀取 PR changed files；API 無回應或頁數／數量不完整則驗證失敗，不默默標小改。
- PR 內容缺少中／大改必要欄位，或欄位仍填「待補」「TBD」，風險檢查失敗；這是**說明完整度 Gate**，不會確認測試真的執行，不能取代安全 Code Review、必要 CI、E2E、Preview 或 #33 發布核可。
- 修改檢查器本身的 PR 也必須由人工審查；`pull_request` 可讀取 PR 提供的測試程式碼，因此該工作流程不是強制安全邊界。後續須由具權限管理員在目標分支啟用 Required Status Checks / 合併審查，並與 #56 治理 PR 協調。
- 既有未更新說明的中／大改 PR，重新觸發此 Action 可能失敗；需補上風險與驗收證據，而不是取消檢查以求通過。

## 變更門檻

1. **開始前：** Issue、目標分支、base SHA、修改檔案清單與碰撞矩陣，列出使用中的功能和相關負向權限測試。
2. **開發中：** 限制修改範圍；不讓架構 PR 同時改 UI 行為、SQL 與部署設定。非零重疊先協商衝突、將第二個 PR rebase 到第一個已驗證提交再重跑測試。
3. **合併前：** 檢查 GitHub 必要 CI 的結論及 merge SHA；`failed` / `skipped` / `cancelled` / `pending` 不能算成功。PR #56 的保護規則若尚未強制生效，人工核對不可省略。
4. **Preview：** 核對 Netlify deploy ID、`commit_ref`（若有）、build badge、路由／靜態檔雜湊、登入與 401/403、LINE 深連結、CORS；不能用旧 SHA 的成功紀錄。
5. **正式：** 只有 #33 完整準入、後端 migration/Edge 部署相容、備份與回退計畫、授權核准才可執行。Docs PR 不授權正式發布。

## 環境與模組隔離

- 先保留 `MemberWebsocket-dev/` 原目錄與 `/admin/`、`/platform/`、`/booking/`、`/member/`、`/points/` 等路由；每次重構只搬一組被測試保護的資產。
- Supabase 暫時不能假設有 staging branch。**缺少隔離時只做本機合成資料與不改寫正式資料的檢查**；正式 Supabase 上不跑 destructive E2E、重置或 `supabase db push`。
- 保留已部署 migration 原檔與既有版本歷史。新 schema 使用新增 migration，通過 sandbox／重放驗證才考慮部署；PR #101 接手比對來源與 migration history。
- 前端路由／隱藏按鈕不等於授權，角色及商家範圍仍由 Edge 和 DB/RLS 驗證；publishable key 可公開，service_role、JWT secret、LINE Secret 絕不放到輸出資產。

## 工作流及驗收

- #125（P0）：先形成唯一發佈來源清冊及風險決策，不直接停用既有 publisher。
- #127（P1）：整理 Node、DOM、Chromium、SQL、Edge 的跨模組回歸矩陣，可和 A 軌並行。
- #126（P1）：#125 確認路徑基線後小批次動共享 JS/CSS，每次一個 PR。
- #128（P2）：前三階段有收益證據後再決定是否 `apps/web/`，**不搬也可結案**。
- #129 Epic：以 PR、測試、部署證據更新進度，不能因文件建立就把任務標示已完成。

驗收定義：每一個實作子 PR 都要列出 `Issue → 受影響路徑 → 失敗測試 → 修正 → 完整 CI → Preview SHA → 回退方式`；只做文件更新時，明確標示未觸及產品程式碼，未宣稱產品測試已跑。

## 風險與解除條件

| 風險 | 停止線 | 解除證據 |
| --- | --- | --- |
| Git/Netlify 多來源發布 | 禁止單憑推送 `develop` 認定可安全上正式 | #125/#33 實測 publisher、branch 設定與回復鏈 |
| SQL / Edge 與前端版本飄移 | 禁止對正式 DB 直接套 migrations 或覆寫 Edge | #35/#101 精確來源與 DB history 差異對照 |
| PR 檔案碰撞 | 不同 PR 改動同個共用檔案或契約 | 重新整合基線後全部測試重跑 |
| 開發 DB 未隔離 | 不可在正式庫跑 destructive tests | 有專用 sandbox 或可回復的本機實驗環境 |
