# ARCH-01：部署來源盤點與舊匯入器退役（2026-10-25）

關聯：[Issue #125](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/125)、[#33](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/33)、[#40](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/40)。本文件為 **唯讀核對 + 待審核 PR**，不是正式發布切換命令。

## 第一性原理與不變條件

- 目標：正式環境只有一條可稽核、需 CI 與授權核准的發布路徑。
- 不變條件：Preview 不可覆蓋 Production；舊 Repository 不能覆寫既有會員、商家、LINE、預約或點數程式；未核對來源 SHA 不可認列正式部署驗收。
- 限制：保留現行 LIFF URL、部署站點、Supabase 資料及所有既有驗收門檻；本 PR 不改業務 API、資料庫、Netlify site 設定、環境變數或遠端正式部署。
- 決策：先退役有明確覆寫風險的舊來源匯入器，**不在本 PR 將 Production publisher 從 develop 切至 main**。

## 實際核對的來源對照

| 資源 | 唯讀核對證據 | 不能從此推論 |
| --- | --- | --- |
| `main` | `8d1b624876947e178f8fa078ddf02b4258dbb7ad`（查核時） | 不代表 Netlify 正式站從 main 自動部署 |
| `develop` | `b04486a557ae35c126531cdd1bdb15a22667be5d`（查核時） | 不代表現在所有功能都部署到 Production |
| `Integrated-Marketing-Platform` | `e58d626eaef0e189849e4a4eb759af6d4bea94dd`（查核時） | 不等於最後已發布的 Preview SHA |
| Netlify Site | `23796c62-480a-4b46-ac90-bfbc5ad4d300` | Site ID 不代表 Git 來源已鎖定 |
| Production Deploy | `6ad34aa232fcb1cea452346f`，ready，`context=production`，`deploy_source=api`，`commit_ref=null`，`branch=master`；標題包含 `verified-develop-b04486a...` | 標題不是可驗證的 `commit_ref`；Netlify UI 的 Production branch 仍待人工核對 |
| 整合分支 Deploy | `6add5ddd7455cb114294353d`，ready，`context=branch-deploy`，`branch=Integrated-Marketing-Platform`，`commit_ref=e5c97cfef964a80250be359355c26ee1643104ee` | 不代表當前整合 HEAD `e58d626` 已部署 |
| Supabase | `MemberWebsocket-dev`，project ref `dbuquirnaskrwcamdxki`，ACTIVE_HEALTHY | 健康狀態不代表 migration、Edge Functions 與 Git 完全一致 |

可重新核對的來源：GitHub Branch API；`.github/workflows/publish-netlify.yml`、`netlify.toml`、`scripts/build-site.mjs`；Netlify Deploy API；Supabase Project API。

## 發布與覆寫路徑

1. **現有 Production publisher：** `.github/workflows/publish-netlify.yml` 在 `develop` push（特定 paths）或手動 workflow_dispatch 執行，建置後等待 exact-SHA 完整 CI 成功，使用 Netlify CLI `deploy --prod` 發布至上述 Site ID。此工作流仍存在；本 PR 未改它。
2. **現有 Preview：** `netlify.toml` 使用 `scripts/netlify-preview-source.mjs --build`；整合分支已有 Native branch deploy。此 Preview 不得被視為 Production 的發布批准。
3. **確認的舊覆寫入口：** 退役前 `.github/workflows/import-source.yml` 在檔案被 push 或手動 dispatch 時，從 `yongshengchen0615.github.io` 的固定歷史 SHA `c1eb08e26a63862d88d91e57a4eda52a11246e5b` 複製原始碼及部署檔案，最後執行 `git push origin HEAD:main`。這可能把審查過的新來源覆寫成舊快照。
4. **本 PR 改動：** 刪除上述舊匯入 workflow（Git 歷史保留），並在現有 `scripts/netlify-publish-workflow.test.mjs` 加入防退化測試，阻止其以原檔名復活。這不是全庫阻止其他任意工作流推送的完整授權控制。

## 相容性與發布風險矩陣

| 層面 | 此 PR 影響 | 後續正式切換之前必須驗證 |
| --- | --- | --- |
| Netlify Production | 無（不觸發此站部署） | Git connected production branch、API/CLI/Build Hook 的所有 publisher、branch context、最新 commit 與 rollback deploy |
| Preview/CI | 既有 workflow 測試新增一個靜態不變條件 | 同 SHA 主產品 CI、Netlify build、Preview smoke 與失敗關卡不被略過 |
| LINE LIFF | 無 | 所有既有 endpoint URL 與 login callback 原樣有效；總管理、一般管理、會員均完成真人驗證 |
| CORS / Edge Functions | 無 | 每個原 origin/callback/tenant context 的安全回歸 |
| Supabase / migrations | 無 | develop/Production 差異清冊；隔離測試庫遷移、還原與 RLS 回歸；不以數量差直接套用 |
| 會員／預約／點數／票券 | 無 | 身分、跨商家隔離、交易守恆與負向 E2E 需正式驗證 |

## 驗收（Given / When / Then）

- **AC-ARCH-01-01** Given 三條分支與 Netlify Deploy API 可讀，When 對照 SHA、context、production / branch-deploy，Then 明列確定與尚待 Netlify Dashboard 查證的發布身分；目前 **部分完成**。
- **AC-ARCH-01-02** Given 開發與正式發布原先可能多路，When 設計唯一 publisher，Then 先退役歷史 importer，之後獨立提案統一 Production 至 main、需審查／完整 CI；目前 **方案已建立，尚未切換**。
- **AC-ARCH-01-03** Given 發布路徑可能牽動外部 LINE / API，When 評估切換，Then 列出 Netlify、LIFF、CORS、Edge、migration 與回復 Gate；目前 **已建立檢查矩陣，尚待真實服務驗收**。
- **AC-ARCH-01-04** Given 此 PR 僅退役危險 workflow，When 提交最終 SHA，Then 所有必需測試與審查、Preview smoke 成功才能合併；目前 **未完成**。

## 後續順序與回復方式

1. 本 PR 維持 Draft，由獨立 Reviewer 檢查變更與 CI；僅完成 PR 不得移 Done。
2. 在 Netlify Dashboard 核對站點的 Git Production branch、Build Hooks、手動部署權限和所有可能的 publisher，保存截圖/設定證據。Netlify Deploy `commit_ref=null` 不能用部署標題補當來源身分。
3. 與 #33/#40 的 Gate 整合後，獨立 PR 將 **唯一 Production publisher** 指向經批准的主線（建議 main）；移除或鎖定舊 develop publisher，並以最終 SHA 比對產物後才切換。
4. 若此 PR 的匯入器退役需要回復，以 Git revert 恢復該檔並重新審查，不可直接自動執行舊工作流；若正式部署日後失敗，使用保留的已驗證 Netlify deploy 與原資產恢復，不對 Supabase 做未經驗證的降版。
5. Project #5 自訂 Status/Priority 欄位在此輪連接器操作回傳 `403 Resource not accessible by integration`；本 PR 不聲稱已寫卡或完成卡片移動。

## 測試責任

變更檔案限本文件、`scripts/netlify-publish-workflow.test.mjs` 與刪除的舊 Workflow。測試應由最終 SHA 的 GitHub Actions 實際回報：`node --test scripts/netlify-publish-workflow.test.mjs`、全專案 `Test MemberWebsocket Dev`、`Test Netlify build`、必要 Browser E2E / SQL / Edge / 安全檢查；如被 `paths` 篩選、取消、跳過或無資料，全部標為 **未驗證**，不冒稱通過。
