# Project #5 Status automation — GitHub GraphQL Projects v2

這是 `yongshengchen0615` 個人擁有的 [Project #5 看板](https://github.com/users/yongshengchen0615/projects/5/views/3) 的獨立自動化通道。僅對既有 `memberwebsocket-dev-netlify` Issue 卡片更新 **Status**，不新增／刪除 Project item、不修改 Priority、不碰正式會員資料。

## 啟用（需要帳號擁有者完成）

1. 建立 GitHub personal access token。建議優先採 **fine-grained PAT → Account permissions → Projects → Read and write**（確保有權讀取目標 Issue）；或使用 classic PAT 的 `project` scope。由使用者檢查最小權限、到期日與輪替政策。GitHub 內建 `GITHUB_TOKEN` 無法跨儲存庫範圍管理個人 Project。
2. 在儲存庫 **Settings → Secrets and variables → Actions → New repository secret** 中建立 `PROJECTS_V2_TOKEN`，值為上述 PAT。**不要把 token 貼在 Issue、PR、聊天訊息、source、workflow YAML。**
3. 合併本 PR 至儲存庫的 **預設分支 `main`**。GitHub `workflow_dispatch` 與 Issue event 須由預設分支的 workflow 接收。
4. 進入 **Actions → Project 5 Status (GraphQL) → Run workflow**，輸入 `issue_number=40`，目標選 `觀察中`，先維持 **apply 未勾選**。在 Action log 確認 JSON 的 `action=preview` 或 `unchanged`。
5. 核對當前驗收證據確實支持狀態後，勾選 **apply** 再執行。成功時 log `action=updated`，程式已向 GitHub 重新查詢該 item。再重新載入 [Project #5 看板](https://github.com/users/yongshengchen0615/projects/5/views/3) 獨立核對移動結果。

## 自動觸發：Issue 標籤

需先於 GitHub Issues 建立下列六個標籤。每個 Issue 同時只能有 **一個** `project-status/` 標籤；換狀態先移除舊標籤，再加新標籤。

| 加入標籤 | 移至 Status |
|---|---|
| `project-status/backlog` | 待規劃 |
| `project-status/ready` | 準備開始 |
| `project-status/in-progress` | 開發中 |
| `project-status/code-review` | 程式碼審查 |
| `project-status/qa` | QA / E2E |
| `project-status/blocked` | 已阻塞 |

**不自動推進「已完成」、「等待部署」、「觀察中」**，因為它們需完整驗收／部署依據。這三種狀態僅能手動工作流程明確選擇並啟用 apply。Issue 關閉不會自動視為產品驗收完成。

## 技術與安全保證

- 官方 [GraphQL Projects v2 API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) 的 `updateProjectV2ItemFieldValue`，使用 `singleSelectOptionId`。
- 固定 Project owner、編號與 repository，從即時 Project 查出單一 Issue item 與 Status option ID；拒絕找不到、多筆、欄位設定不符、pagination 失敗。
- 預設預覽；寫入前再次查詢原值，避免覆蓋已知的並行變更；寫入後獨立讀回驗證 Status 及 item 歸屬。
- Label 事件另外重新查詢即時 Issue labels，拒絕衝突或舊觸發事件；不執行 Issue 標題、內文或 PR 上傳腳本。
- GitHub Actions workflow 設 `permissions: contents: read`，PAT 僅存在 Actions Secret；GraphQL 錯誤不回顯可能敏感的 provider payload。
- 未設定 PAT、403、找不到卡片、GraphQL schema 錯誤或寫入後讀回不符，都以 exit code 1 失敗，不宣稱成功。此流程不處理 Issue PR 或 Project draft items。
- 外部使用者從 GitHub UI 同時移卡時，API 不提供原子 CAS；本工具只能降低競爭、不能保證無覆寫風險。

## 測試／回復

本機測試：`node --test scripts/project-v2-status.test.mjs`；PR 應執行新增的 Project Status contract tests 及既有全專案 CI。測試 fixture 不是實際 Project API 驗收，正式通道啟用仍需上述 dry-run → apply → UI 讀回。

若 log 回報「read-back mismatch」，視為**結果未定**，先核對 UI，不要直接判定寫入失敗。若移錯卡片，從先前 log 的 `from` 欄位取得原 Status，使用手動 workflow 明確回復；要緊急停止自動化可撤銷 PAT 並移除 `PROJECTS_V2_TOKEN`。