# Business Context DOM Implementation Plan

> **For agentic workers:** Execute with superpowers:executing-plans; one bounded task with a final independent review.

**Goal:** 商家入口局部 DOM 更新不再反覆掃描整頁，保留權限與導航契約。

**Architecture:** 保留 BusinessContext 公開介面。gate/retain 接受 root，MutationObserver 去除重疊與已移除根；相同 features/品牌/連結採冪等寫入。

**Tech Stack:** 原生 JavaScript、JSDOM、Node test、Playwright；無新增套件。

**Spec:** `docs/superpowers/specs/2026-11-25-business-context-dom-design.md`

## Global Constraints

- 基準 `81de73c5b4f8772449649967f02a06f6a5abcfd5`，PR 回 `Integrated-Marketing-Platform`，僅測試環境。
- API、LINE 驗證、商家隔離、資料與後端授權不變。
- 無新增 timer、快取、依賴、資料庫遷移；不削弱完整 CI。

## Review Focus

- 新增節點本身就是 link 或 gate，不能只檢查後代。
- 同批包含父與子 mutation，不能重複遍歷同一子樹。
- 移除後的節點不得改寫；文字更新不能掃描整份文件。
- 商家切換後不能保留舊商家導航或舊權限。
- 未變更權限的 refresh 仍需讓新內容取得正確 gate；observer 不得產生自觸發迴圈。

### Task 1: Scope and verify BusinessContext DOM updates

**Files:** Modify `MemberWebsocket-dev/business-context.js` and the DOM integration CI lane. Create `tests/helpers/business-context-dom.cjs`, `tests/integration/business_context_dom.cjs`, `tests/browser/business-context-dom.spec.cjs` and `scripts/benchmark-business-context-dom.mjs`.

**Interfaces:** Public `configure/refresh/set/allows/allowsBenefit` remain unchanged. Test helper consumes source text and returns real JSDOM window plus query/write/request metrics; benchmark supplies source via git show for identical fixtures.

- [ ] Add observable DOM and work-count tests for AC-001..005; run on baseline and confirm expected failures.
- [ ] Modify root-scoped gate/retain, idempotent writes and observer batching; run new and existing routing/connection/grant tests, expect no failures or skips.
- [ ] Run controlled before/after benchmark; preserve raw JSON and limits of inference.
- [ ] Connect integration test to executable CI; run CI inventory and runtime-quality, expect exit 0.
- [ ] Run full application regression, scripts, browser and build checks; verify remaining full CI on exact candidate SHA. Record every failure/blocked layer without treating it as pass.
- [ ] Commit, independent review, then prepare a reviewable PR with test evidence and rollback. Merge/deploy testing only if all required checks are successful and authorization covers it.
