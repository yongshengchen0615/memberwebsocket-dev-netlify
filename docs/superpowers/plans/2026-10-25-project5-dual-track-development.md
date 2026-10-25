# Project #5 雙軌開發 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不中斷功能開發的條件下，讓架構清理具有可重現的發布來源證據、測試 Gate、模組邊界與回退方法。

**Architecture:** 單一 Monorepo + 兩條短生命週期 PR 軌道 + 單一整合驗收分支。每階段保留原公開路由與 Supabase migration history，整合採每次一個 PR 的精確 SHA 驗證；Production 始終獨立審核。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node 24（部分 integration 測試為 Node 22）、GitHub Actions、Netlify、Supabase/PostgreSQL、Deno Edge Functions、LINE LIFF。

**Spec:** `docs/superpowers/specs/2026-10-25-project5-dual-track-development-design.md`

## Global Constraints

- 不直接更改 `main`、`develop`、整合分支、正式 Netlify、Supabase、LINE 設定；所有變更先隔離在 PR。
- 現行前端源碼路徑為 `MemberWebsocket-dev/`；`scripts/build-site.mjs` 目前依賴它並輸出 `dist/`。
- 正式發布基線必須與 Netlify 真實 deploy ID / SHA 核對；不能僅信任 workflow 名稱。
- 未核准前不新增付費 Supabase branch、不執行 migration 寫入、不跑破壞性測試。
- Feature、Refactor PR 若修改相同共享模組，以依序合併與重新測試處理，不允許兩邊覆蓋。
- 優先復用既有 #33/#35/#40/#47/#56 及 PR #57/#101，不複製現有治理/漂移檢查器。

## Review Focus

1. **Docs-only PR 沒有觸發所需 CI：** 不得將未觸發標為通過；需手動驗證或調整路徑策略，另開 PR。
2. **`main`、`develop`、整合分支前進：** 重新取目標分支 HEAD 與檔案清單，PR 基線失效必須更新。
3. **兩軌共享 JS/Edge/SQL 重疊：** 停止同時合併，先完成契約相容性檢查。
4. **Supabase history 版本識別不一致：** 不用數量差直接推導尚未部署，必須按版本、檔案內容及追蹤紀錄比對。
5. **Netlify deploy title 顯示 develop 但 branch 顯示 master：** 不能據單一欄位改 Git-CD 設定；應比對 API、dashboard 及發布流程的權威證據。

---

### Task 1: 發布來源與環境唯讀基線（#125）

**Files:**
- Create: `docs/architecture/project5-release-source-inventory.md`（獨立 PR）
- Read: `.github/workflows/publish-netlify.yml`, `.github/workflows/publish-platform-preview.yml`, `netlify.toml`, `scripts/build-site.mjs`
- Test: 只讀盤點檢查及 `node --test scripts/deploy.test.mjs scripts/netlify-publish-workflow.test.mjs`（可在本機 worktree 執行）

**Interfaces:**
- Consumes: GitHub branch refs / Actions runs、Netlify Site 與 Deploy、Supabase migration metadata。
- Produces: 來源清冊（branch, SHA, workflow, deploy ID, Supabase project/ref, evidence URL, uncertainty）。

- [ ] **Step 1:** 擷取三條分支最新 SHA、保護狀態、相關 workflow、Production 與 Preview deploy 及 Supabase branch list；記錄抓取時間。
- [ ] **Step 2:** 把 Netlify `branch`、`deploy_source`、`commit_ref`、title 的差異列成待證實事項，不任意更改來源。
- [ ] **Step 3:** 撰寫唯讀清冊；比較現有 #33/#40 報告，列明受阻項目與回復擁有者。
- [ ] **Step 4:** 執行已有部署契約測試，記錄 exit code、fail/skip 及 base SHA；沒有本機環境就標註未執行，不冒稱通過。
- [ ] **Step 5:** 以純文件 PR 審核清冊；確認後才另開修改發布設定的 PR。

**Expected:** 具備可用於決策的單一來源對照表，未影響正式部署。

### Task 2: 測試矩陣與合併閘門（#127）

**Files:**
- Create: `docs/quality/project5-module-regression-matrix.md`（獨立 PR）
- Modify (僅在另案通過測試設計後): `.github/workflows/test-memberwebsocket-dev.yml`
- Reference: `MemberWebsocket-dev/tests/*.test.js`, `MemberWebsocket-dev/tests/integration/`, `MemberWebsocket-dev/tests/browser/`
- Test: `node --test MemberWebsocket-dev/tests/*.test.js`、對應 integration/browser CI、`node --test scripts/deploy.test.mjs`

**Interfaces:**
- Consumes: Task 1 發布清冊、既有 #47 測試矩陣。
- Produces: 每個模組的 `AC → 測試路徑 → 工作流程 → Preview` 對照與 required-check 清單。

- [ ] **Step 1:** 盤點會員、預約、點數、票券、日曆、管理端及權限跨模組行為，將現有測試逐項映射。
- [ ] **Step 2:** 每個缺口先新增能重現風險的失敗案例（RED）；再在最小 PR 內實作補救（GREEN），並重跑原有完整測試。
- [ ] **Step 3:** 查核 GitHub Required Checks 實際是否強制、docs-only 是否漏跑、PR 與 push 工作流程是否會被取消；不以 Workflow 有設定等同 Ruleset 生效。
- [ ] **Step 4:** 更新必要 CI 時，以獨立小 PR 補自動化契約測試，驗證正常/缺席/失敗/取消/重跑情境。
- [ ] **Step 5:** 同一個合併 SHA 上交付全套證據，通過後標為 QA；未達者維持未完成。

**Expected:** 新功能與重構採同一組已驗證的測試 Gate；不影響既有業務流程。

### Task 3: 限範圍的共用資產整理（#126）

**Files:**
- Read: `MemberWebsocket-dev/index.html`、`MemberWebsocket-dev/admin/`、`member/`、`booking/`、`points/`
- Create: `docs/architecture/project5-shared-assets-map.md`（獨立 PR）
- Modify (後續、僅選定 1 個低風險模組): 現有某一支重複 JS/CSS 和其引用 HTML
- Test: 對應模組 Node/DOM 回歸 + `node scripts/build-site.mjs` + `node --test scripts/deploy.test.mjs`

**Interfaces:**
- Consumes: Task 1 原路由基線、Task 2 測試矩陣。
- Produces: 共用資產地圖 + 一個有完整 RED→GREEN 與回復方法的微型重構 PR。

- [ ] **Step 1:** 先產出「來源檔 → 被哪些入口引用 → 是否為共享契約」表，不移動任何檔案。
- [ ] **Step 2:** 選擇目前沒有 Feature PR 修改的低風險模組；列出相同路徑 PR 碰撞。
- [ ] **Step 3:** 加一個能攔截缺檔、路由變更或行為回歸的失敗測試，實測 RED。
- [ ] **Step 4:** 執行最小重構；運行本模組及全套回歸、建置、靜態 URL／檔案檢查，看到 GREEN。
- [ ] **Step 5:** PR 內提供 before/after 依賴圖、源碼 SHA、回退提交；不得跨模組混入業務變更。

**Expected:** 一個可合併、可回退、無外部行為變更的小範圍重構，而非全盤搬目錄。

### Task 4: 長期目錄／Supabase 環境決策（#128）

**Files:**
- Create: `docs/architecture/decisions/2026-10-project5-monorepo-structure.md`（ADR、獨立 PR）
- Read: #95 三 Repo 替代方案、#35／PR #101 migration 稽核、現有 `netlify.toml` 和 LINE LIFF 路徑
- Test: 如 ADR 選擇搬遷，須新增所有前端入口與相對資產、Edge、SQL、LINE 深連結、授權負向 E2E 的遷移測試；未選擇搬遷則不需寫產品程式。

**Interfaces:**
- Consumes: Tasks 1–3 的清冊、測試、實際維護收益。
- Produces: ADR（繼續現況／Monorepo apps/web／多 Repo），以及必要時的遷移、回退與授權計畫。

- [ ] **Step 1:** 評估三方案改動檔案數、重複邏輯、CI/Netlify/Supabase 風險與維護成本。
- [ ] **Step 2:** 如不遷移收益較高，記錄維持現狀的理由，結案「決策」而非假性遷移。
- [ ] **Step 3:** 如選擇遷移，先在完全隔離 Preview 驗證遷移測試及來源一致性，禁止正式 DB 的 `db reset`。
- [ ] **Step 4:** 提出正式發布所需人工批准清單、重放 SQL 策略、LINE 回呼／路由回滾；不在此階段直接發布。

**Expected:** 具可追溯收益及安全證據的 ADR；只有必要且有授權時才進行大型遷移。

## Handoff and Acceptance

此規劃檔先由 PR 審閱；**本次只新增設計與執行文件，未執行上方任務的產品程式修改或 E2E。**

在啟動實作前，工作者必須先檢查遠端最新 SHA、PR 撞檔、Ruleset 有效性及可用的獨立測試環境。每個任務都應單獨開 PR，完整記錄 RED→GREEN、CI、Preview 與回復證據；任何未執行步驟保持未勾選。
