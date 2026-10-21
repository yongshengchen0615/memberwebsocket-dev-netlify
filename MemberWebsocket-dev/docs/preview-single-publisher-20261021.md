# Preview 單一發布來源：#33／#40

## 已讀回事實

唯讀 Actions run `39621537663`，候選 SHA `fce6465fe0993935e75f685e20c4eacb64a0f8c8`：

- 既有站點 `23796c62-480a-4b46-ac90-bfbc5ad4d300`，Git repository 為本儲存庫。
- Production branch 實際為 `master`；published deploy 為 `6ad34aa232fcb1cea452346f`。
- allowed branches 包含 `master`、`develop`、`Integrated-Marketing-Platform`。
- 原生 Git branch deploy `6ad892118bc22a8a08d1e9d5` 保留完整大小寫及 commit `4319343c0973333980779ce971b77a0a9b32856d`。
- CLI alias deploy `6ad8954a695249e48e388cae` 的 branch 為小寫 `integrated-marketing-platform`，沒有 Git build／commit，context 仍回傳 `branch-deploy`。因此不能只靠 context 辨識 CLI 與 Git。
- 原生 Git 與 CLI 使用不同建置產物；同 SHA 不代表相同 bytes。

Artifact：<https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/39621537663/artifacts/12354484224>。
沒有讀取或輸出環境變數、provider 原始回應、token、部署 title 或完整建置命令。

## 決策與範圍

保留現有 Preview 網址，將 `Integrated-Marketing-Platform` 的受控發布集中在 GitHub Actions。
替代的新 alias 需要重新核對 LINE、CORS 及使用者入口，影響面較大，這次不採用。
Production、`develop` 及 PR Deploy Preview 的原有建置維持。

1. `netlify.toml` 的 ignore command 阻止整合分支的原生發布；build wrapper 也拒絕該分支的非 PR 原生建置，以防 build hook 繞過 ignore。
2. Actions 維持同 SHA 最新完整 CI／build／Ticket Policy gate，發布前確認分支 HEAD。
3. 透過 Netlify 官方 ZIP branch API，以原始大小寫的 branch 上傳同一份 dist，不再對此分支使用 CLI alias。
4. 上傳前核對站點、repository、Production branch 及競爭中的部署；只接受指定站點及整合分支。POST 不重送，逾時須先查真實部署，避免建立重複產物。
5. 由 `netlify.toml` 產生 ZIP 內的 `_headers`／`_redirects`，保留既有設定；新增不支援的 redirect 選項會中止發布，需先審查。
6. 上傳後讀回 deploy ID／site／branch／context／ready，確認 Production published deploy 未變。最後依原有 smoke 核對 10 頁、5 資產、301、CORS、401／no-store。
7. 併入 #62 的 `passedChecks` 摘要修正，逐網址 `checks` 陣列不得被覆蓋。

這是 Preview 發布工具修正。沒有修改會員業務、Supabase 結構、帳號權限、LINE Channel／LIFF 或 Production 發布來源。

## 驗收與測試

| AC | Given／When／Then | 證據來源 |
|---|---|---|
| AC-SOURCE-001 | 原生整合分支或 hook 開始建置時，拒絕其發布；master、develop 與 PR preview 保持可建置 | `netlify-preview-source.test.mjs`、真實合併後 Netlify build |
| AC-SOURCE-002 | 有錯站點、Production 同名分支、競爭中的部署或缺 SHA 時，在 POST 前拒絕 | `netlify-preview-source.test.mjs` |
| AC-SOURCE-003 | 上傳成功後只接受原分支／站點的 branch-deploy；錯 context、錯身分、terminal failure 或逾時不算成功 | `netlify-preview-source.test.mjs`、真實部署證據 |
| AC-SOURCE-004 | ZIP 發布保留全域 routing／headers，穩定入口與 artifact bytes 一致且未登入仍拒絕 | workflow contract、`verify-platform-preview.test.mjs`、線上 smoke |
| AC-SOURCE-005 | 診斷使用白名單欄位；秘密、provider 原文及錯誤 body 不進報告 | `inspect-preview-source.test.mjs`、已成功的唯讀 run |
| AC-SOURCE-006 | 成功報告保留 18 筆逐資源紀錄及摘要計數 | #62 回歸案例、實際 report artifact |

執行：`node --test scripts/*.test.mjs MemberWebsocket-dev/tests/*.test.js`。
全部必要 CI 依 `.github/workflows/test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`；必要 lane 取消／跳過／失敗不得放行。
本地暫存目錄需可寫；受限環境應先設定 `TMPDIR`，不能把 `/tmp` 不存在造成的失敗計為通過。

開發中 14 項診斷／發布案例已執行成功；最終 SHA 的完整基線、合併 SHA CI、真實 ZIP branch 發布與線上 smoke 必須另讀回。
未執行的真實驗收不計為通過。#36 仍須不同管理員／會員 LINE 身分與核可 sandbox 的真實收件證據。

## 執行及回復

- 一般本地建置：`node scripts/build-site.mjs`；Netlify：`node scripts/netlify-preview-source.mjs --build`。
- 唯讀盤點：由 `Inspect platform preview source` workflow 執行，憑證只透過既有 Actions secret 注入。
- 發布只能由原 Preview workflow 通過全部同 SHA gate 後執行；不手動使用 production 旗標。
- 發布失敗不執行舊 deploy restore。先定位 stage／request ID／deploy ID，再修正程式並依同一 gate 重發。
- 若需撤回本修正，以新的修復提交恢復 pipeline；先選定唯一發布來源，不能直接恢復雙 publisher。Production 不在本輪操作範圍。

官方契約：<https://www.netlify.com/changelog/2025-11-21-deploy-with-zip-file-supports-branch-deploys/>；
<https://open-api.netlify.com/#tag/build/operation/createSiteBuild>；
<https://cli.netlify.com/commands/deploy/>。
