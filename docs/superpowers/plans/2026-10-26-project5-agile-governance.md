# Project #5 Agile Development Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 為 Project #5 加入輕量 Scrumban 與真正可驗收的 DoR/DoD，維持原品質與發布 Gate。
**Architecture:** AGENTS 精簡入口 + docs/AGILE_DEVELOPMENT.md 詳細流程 + Guardrails 安全對齊 + 既有治理 Node test。
**Tech Stack:** Markdown、Node.js node:test、GitHub Actions。
**Spec:** docs/AGILE_DEVELOPMENT.md

## Constraints
- 不改程式產品、資料庫、Netlify、正式發布、Project Status 或 Iteration 欄位。
- 延用 Draft PR #57；合併及驗證 GitHub Ruleset 前不能宣稱正式生效。
- 一週 Sprint / WIP=2 是管理建議，不是不可調整的工程限制。

## Review Focus
- 單人與 AI Agent 不被重型 Scrum 儀式阻塞。
- P0 插單保留 CI 與授權。
- Sprint 結束不自動將未驗收工作 Done。
- DoR 不完整時 Spike 可安全探索。
- 不因新增規範產生虛構 GitHub 欄位。

## Task 1: 規範與測試
- [x] 加入 docs/AGILE_DEVELOPMENT.md：迭代目標、DoR、DoD、WIP、P0 與九個 Status。
- [x] 更新 AGENTS.md 和 DEVELOPMENT_GUARDRAILS.md 入口與界線。
- [x] 在 scripts/governance-workflow.test.mjs 建立防刪除與交付紅線的契約案例。
- [ ] 最終 SHA GitHub Actions 完整 CI、Reviewer 及真實運作驗收完成。

## Task 2: 正式導入（獨立後續工作）
- [ ] 依序審查合併 #57／#131／#132，確認 Required Checks 真正生效。
- [ ] 恢復 Projects V2 欄位讀取後，確認是否需要 Iteration；不能直接創建假欄位。
- [ ] 使用一張真實 Issue 演練 Sprint Goal、Daily async、Demo、Retrospective、DoD。
