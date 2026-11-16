# 合併後自動發布資料庫、Edge 與前端

## 目標與邊界

Integrated-Marketing-Platform 推進時部署 MemberWebsocket-test；master 合併後部署 MemberWebsocket-main。沿用現有三條完整 CI 及 Netlify 發布器，順序為同 SHA CI → 增量 SQL → 明確列出的 Edge Functions → 前端 → smoke。任何失敗皆停止後續步驟。不得搬移會員、Auth、Storage、Vault、簡訊／LINE 秘密或測試重置工具。

已確認：來源 f76cfa96e866494854f344dced47aebcbd74c6ca；正式 dc272e8ed0a1c03d71a27881e04228089ba8324a。正式 migration history 是逐次版本，測試 history 是 clone_* 快照，無法直接共用 db push。兩邊已存在 public.members 與 platform_private.super_admins。新流程不宣稱舊結構完全一致。

## 選擇

| 方案 | 相容性與成本 | 決策 |
|---|---|---|
| 對既有目錄直接 db push | 版本不對齊，可能重放資料清理 migration | 排除 |
| 重建資料庫、重整所有歷史 | 要搬移正式資料與秘密，影響超出需求 | 排除 |
| 凍結歷史檔案，交易式發布新 migration | 保留既有歷史；新增一張僅部署者可用的校驗紀錄表 | 採用 |

這是實作者依現況選定的最小相容方案。使用官方 Supabase Management query API 執行單一 PostgreSQL transaction；deployment_private.schema_releases 保存 filename/version/SHA256/source SHA。舊 migration 的校驗 manifest 不代表它們已在兩邊逐項驗證，只代表它們不會被自動重播。新 migration 必須晚於 20261111134000，已存在的登入欄位授權修復可冪等執行；其他新增 migration 由 CLI 產生檔名。

## 身分、狀態與不變條件

- 僅 GitHub 可信任分支 push 的發布 job 可寫後端；PR、Netlify 原生建置不得執行 SQL 或取得管理憑證。
- 固定 project ref 與獨立 TEST/PRODUCTION access token。缺失、專案驗證失敗或分支已前進立即停止。
- 遷移 transaction 使用 advisory lock、lock/statement timeout；SQL 與 checksum 紀錄一起提交。失敗全批 rollback；同版重跑不重放；改寫或刪除已套用 migration 拒絕。
- 新 migration 需保持舊前端/Edge 相容；部署不是跨 Supabase/Netlify 的原子交易。Edge 中途失敗可能有部分新版函式，因此不自動倒退或刪除資料，只保留舊前端並修復前進。
- 測試發布先在獨立 release_probe_<SHA> 合成 schema 實測 Management query API 成功提交、22012 故障 rollback、寫後讀回及無 CASCADE 清理。結果或清理不符即停止，不執行應用 SQL；正式專案不執行故障探測。同名 scope 已存在時拒絕覆寫。
- 新 SQL 禁止頂層交易控制，避免破壞外層原子性。BEGIN/COMMIT 只有既有授權修復的外層包裝可移除。不提供通用 SQL 安全沙箱；具寫權的審核者仍需審查破壞性變更。
- 部署名單只包含現有 canonical active 函式，排除 retirement、*-preview、sql-full-reset-worker。新增函式需在名單宣告；不執行 blanket deploy。
- Integrated 原生建置除了原 CI gate，必須取得同 SHA 後端完成標記。標記僅 GitHub 在後端成功後寫入 Netlify branch build scope。

## 驗收與影響矩陣

| AC | Given / When / Then | 層級 |
|---|---|---|
| AC-001 | Given 任一發布分支，When 解析部署目標，Then 僅能選到所屬 project；其他分支拒絕 | unit |
| AC-002 | Given 凍結歷史，When 舊 SQL 改寫/遺失或新檔時間回插，Then 寫入前拒絕 | unit |
| AC-003 | Given 新 SQL，When 首次/重複套用，Then 結構與紀錄只建立一次 | 真 PostgreSQL |
| AC-004 | Given 第二個 SQL 失敗，When 發布，Then 第一個 SQL 與紀錄皆 rollback，既有合成資料保留 | 真 PostgreSQL |
| AC-005 | Given 已套用 SQL，When 改 checksum/刪檔或並行發布，Then 漂移拒絕/僅套用一次 | 真 PostgreSQL |
| AC-006 | Given CI/SQL/Edge/credential 失敗，When 發布，Then 不發布新版前端，保留可診斷證據且不洩漏 secrets | unit/workflow |
| AC-007 | Given Integrated 原生建置，When 未有同 SHA 後端成功，Then 前端拒絕；其他 branch preview 不寫 DB | unit |
| AC-008 | Given canonical 部署名單，When 規劃 Edge，Then 不含 QA、preview 或 reset；共用檔變更會隨全部明列函式部署 | unit |
| AC-009 | Given 最終 SHA，When 完整 CI 與兩環境線上發布，Then 各別保存 migration/Edge/Netlify/smoke 證據 | CI/live |

部署腳本/workflow → 遷移與發布順序 → AC-001–009；native build gate → 測試站版本/環境隔離 → AC-007 及既有 branch/build 測試。應用程式認證、會員業務與 UI 不改；仍執行既定全專案 CI。新測試採隔離 PostgreSQL 合成資料，不重置正式資料。沒有新增依賴。執行期效能不適用：變更只於發布時執行，不向會員請求增加查詢。

## 秘密、回復與完成條件

GitHub Repository Actions Secrets：SUPABASE_ACCESS_TOKEN_TEST、SUPABASE_ACCESS_TOKEN_PRODUCTION（分別能管理各自專案）；既有 NETLIFY_AUTH_TOKEN 沿用。不將它們注入公開產物、Netlify runtime、日誌或證據。連線 OAuth 不自動等於 GitHub Actions 持有 token。

前端回復至前次已驗證 deploy；Edge 回復至前次相容來源名單；DB 以新 migration 前進修復，破壞性回復需另行備份與授權。重跑已提交 SQL 是 no-op；未知 POST 結果不自動 retry，先查 ledger。

完整完成需最終兩 PR/分支 CI、真 PostgreSQL 新測試與既有全部基線成功，以及每個環境同 SHA 真實發布/冒煙。缺少 credentials 或真實環境驗收時標部分完成且受阻，不宣稱自動部署已啟用。

## GitHub push 事件遺失時的恢復

已確認 436bc477c9af09cc75d6bdf09348c0463492832a 已合併，但 Actions/check runs 為 0；同期官方通報 Actions/PR 效能異常。等待事件與提供完整驗證的恢復入口相比，採後者；不修改舊 push CI gate、不把 PR synthetic merge 測試當作發布證據。

發布 workflow 的 workflow_dispatch 會以相同 commit 的本地 reusable workflow 呼叫三條既有完整基線，不傳遞部署 secrets。三條全部 success 才可進 publish；失敗、取消、skipped 或缺少結果都拒絕。一般 push 仍使用原有三條同 SHA push gate。所有模式保留發布前 HEAD、固定環境、SQL/Edge/後端標記、Netlify 與 smoke；取消中的 workflow 不得開始發布。正式環境仍須等測試實際發布驗證。

AC-010：Given push 工作未建立，When 手動恢復，Then 在同一發布 run 完整執行三條原基線，通過後才寫後端。
AC-011：Given 任一 reusable baseline 非 success／結果遺失，When 恢復，Then 不發布；空結果及非發布分支亦拒絕。
AC-012：Given 一般 push，When recovery jobs 不適用而跳過，Then 原本同 SHA push CI gate 仍完整執行。
AC-013：Given 被取消或 HEAD 已前進的恢復 run，When 即將寫後端/前端，Then 拒絕發布。
AC-014：Given 恢復測試，When 呼叫 reusable workflows，Then 使用相同 commit 的 ./ 相對路徑，部署 secrets 不傳給測試。
