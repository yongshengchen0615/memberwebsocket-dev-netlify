# Project #5 Status automation — GitHub GraphQL Projects v2

這是 `yongshengchen0615` 個人擁有的 [Project #5 看板](https://github.com/users/yongshengchen0615/projects/5/views/3) 的獨立自動化通道。僅對既有 `memberwebsocket-dev-netlify` Issue 卡片更新 **Status**，不新增／刪除 Project item、不修改 Priority、不碰正式會員資料。

## 啟用（需要帳號擁有者完成）

1. 建立 GitHub personal access token。依 GitHub Projects GraphQL 官方說明，建議為個人 Project #5 採 **classic PAT 的 `project` scope**。由使用者檢查最小權限、到期日與輪替政策。GitHub 內建 `GITHUB_TOKEN` 無法跨儲存庫範圍管理個人 Project。
2. 在儲存庫 **Settings → Secrets and variables → Actions → New repository secret** 中建立 `PROJECTS_V2_TOKEN`，值為上述 PAT。**不要把 token 貼在 Issue、PR、聊天訊息、source、workflow YAML。**
3. 合併本 PR 至儲存庫的 **預設分支 `main`**。GitHub `workflow_dispatch` 與 Issue event 須由預設分支的 workflow 接收。
4. 進入 **Actions → Project 5 Status (GraphQL) → Run workflow**，輸入 `issue_number=41`，目標選 `開發中`，先維持 **apply 未勾選**。在 Action log 確認 JSON 的 `action=preview` 或 `unchanged`。
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
## 持續運作：每日健康檢查與 Token 管理

- 在 PR #86 的全專案必要測試通過後，合併到預設分支 `main`；新的 **Actions → Project 5 GraphQL Health** 可用 `Run workflow` 手動檢查，並於每日 02:17 UTC（台灣 10:17）自動執行。
- 健康檢查只讀取真正的 GraphQL `viewer`、`Project #5` 與 Status 單選選項，不修改任何卡片。正常輸出 `action=healthy`。失敗時會留下 Actions 失敗紀錄；請在 GitHub 啟用 Actions 通知，並定期輪替到期的 `PROJECTS_V2_TOKEN`。健康檢查不會替你更新 Token，也不能保證 GitHub 零停機。
- GitHub 502／503／504 或傳輸錯誤時，**只對查詢**最多重試兩次並退避；403／429 不自動重試，以免在權限或速率限制故障時持續施壓。
- **Mutation 永不自動重送**，因為超時的寫入可能已經成功。完成後對同一張 item 重讀 Status 最多三次；若仍不一致，報告 `UNKNOWN`，必須先查看 GitHub Project 再決定重試，避免覆蓋其他人的操作。
- 建議在 `Project 5 GraphQL Health` 成功後，執行 Issue #41 → `開發中` 的 **dry-run → apply → UI 獨立讀回**。這才是有寫入權限且可以實際移卡的驗收證據，模擬契約測試不算真實移卡。
- 狀態標籤觸發與手動 workflow 皆限制於預設 `main` 分支，以減少其他分支版本持有 PAT 的機會。Issues 上的標籤必須由可授權的人操作。
- 若健康檢查顯示 403，先檢查 Token 是否撤銷、過期、缺少 classic `project` scope，以及帳號是否仍有 Project #5 寫入權限；不要直接修改 Projects 連接器的 Status 值作為替代。

## 新增驗收條件

- **AC-PV2-015/016：** 真實 Project 身分與 Status 設定健康檢查；權限不足或選項漂移時安全失敗。
- **AC-PV2-017–023：** 短暫讀取失敗有限重試、403／429 不盲重試、Mutation 不重送、最終狀態核對與不確定結果處理。
- **AC-PV2-024/025：** 排程健康檢查為唯讀，無效事件或存取範圍先拒絕。
- **AC-PV2-LIVE-001：** 真實 GitHub PAT 讀取 Project #5 成功。
- **AC-PV2-LIVE-002：** #41 實際寫入「開發中」，更新後 GraphQL 與 Projects 網頁獨立核對；**未執行前不得宣稱已完成**。
