# #185 / #186 驗收與可回復變更

已確認基線：`acca10c98dce8f20160aa6e9d87f9cbbd29f81bc`。商家頁面原本每 30 秒重查完整資料。通知設定已依模組隔離，但預約管理員／會員仍共用一組 Token；排程訊息使用同一個已建立的 DB client 時，必須讀取目前模組 scope。

| 面向 | 不變條件／決策 |
|---|---|
| 目標 | 商家同步縮短等待、減少沒有變動的完整重載；管理員可獨立設定通知用途。 |
| 身分 | 沿用 LINE provider 驗證、現有 session、撤銷時間與速率限制。同步不是新的認證機制。 |
| 權限 | 每次 API 由伺服器重新查商家狀態、期限、功能權限；私有 schema 由可信商家 context 選取。 |
| 資料 | 通知路由唯一鍵為 tenant + feature + purpose；Token 以既有 AES-GCM 元件加密，associated data 綁定相同範圍；回應、request cache、audit 只記狀態。 |
| 狀態 | inherit／custom／disabled；custom 先驗證 Channel 所屬再儲存。失敗保留原設定；停用不派送；失效用途不得改用另一帳號。 |
| 併發 | tenant row lock、expected version、request UUID 與 payload hash 保護設定寫入；LINE 測試固定目前操作者並沿用 retry key。 |
| 限制 | 不更換 LINE 認證、不開放匿名商家事件、不刪除正式資料。日曆目前沒有主動推播事件，設定不會新增提醒行為。 |

同步方案比較：直接開放私有 schema Realtime 需要重建目前 LINE 與 Supabase 身分橋接；已認證 revision 查詢可沿用現有授權，因此採後者。每 10 秒查 opaque revision，變動時重載，120 秒完整補查；頁面隱藏／離線暫停，恢復時補查。正常 WebSocket 路徑保留原行為。探測頻率增加，但不再每次下載完整資料；正式 DB／provider 成本仍需實際負載觀察。

通知方案比較：每模組、每用途強制填新 Token 會重複設定；採繼承模組憑證並允許用途獨立覆寫。僅預約具備管理員通知事件，其他模組只有會員通知。獨立通知 Token 不要求更換 Login、LIFF 或 Channel Secret。

| 驗收 | Given / When / Then | 證據與命令 |
|---|---|---|
| AC-185-01/02 | 相同虛擬時鐘與固定合成事件 → 執行修改前後實際 JS → 記錄 p50/p95/p99、遺失事件與完整重載數 | `node scripts/benchmark-business-sync.mjs BEFORE.js REPORT.json`；`sync-benchmark.json`。僅排程器量測，不能視為正式 SLO。 |
| AC-185-03/04/05 | 快速變更、請求進行中、背景、離線與解除訂閱 → 變更保留且不重疊／不累積監聽器 | `node --test MemberWebsocket-dev/tests/business_sync_revision.test.js` 及既有 realtime 測試。 |
| AC-185-06 | 未授權管理員、跨商家、撤銷功能 → 伺服器拒絕；查詢只回 revision | `notification_routes.cjs`、既有 auth-contract／business runtime 安全測試。 |
| AC-186-001/002/006 | 未核准、停權、跨商家、失效 session → 拒絕讀寫設定及派送 | 真實隔離 PostgreSQL + production handler；完整 baseline。 |
| AC-186-003/007 | 不同模組／用途設定與後續 LIFF 編輯 → 不覆蓋另一用途，舊憑證仍可沿用 | `notification_routes.cjs`、`business_line_settings.cjs`。 |
| AC-186-004 | 無效或不屬於 Channel 的 Token → 明確錯誤且不更動已儲存設定 | LINE provider stub + 真實 handler；桌面／手機 Chromium。 |
| AC-186-005 | 通知用途有效、停用、密文損壞、重試與切換模組 → 用途隔離、停用不發送、無錯誤 fallback、重試不重複 | `business-runtime_test.ts`、`notification_routes.cjs`、`notification-settings.spec.cjs`。 |
| AC-185-07 / AC-186-008 | 最終提交 → 全專案 baseline、建置與部署後冒煙 → 同一版本具可追蹤執行紀錄 | `.github/workflows/test-memberwebsocket-dev.yml`、Ticket Policy UI、Test Netlify build、Publish verified platform preview。 |

基線保留所有既有測試。新資料模型透過完整空白平台 fixture 與既有商家結構套用 migration；只有新增 private 表與 RPC，不更動正式會員、收據或授權。private 表 RLS 預設拒絕、無匿名／authenticated grants，僅既有服務端身分可呼叫 RPC。

測試修正紀錄：第一輪 Chromium 全套 254 pass / 2 fail。失敗快照的全部中文字為 UTF-8 被 Windows-1252 解碼的亂碼，新獨立測試 HTTP 頁面沒有 charset；實際 `admin/index.html` 第 5 行已有 UTF-8 meta。測試 fixture 補上 UTF-8 HTTP header、meta 與 `document.characterSet === 'UTF-8'` 斷言，保留原本中文可存取名稱與所有業務斷言，沒有藉由變更 selector 略過問題。

回復方式：停止新增獨立路由設定，將需回復的用途改回 `inherit`；保留資料表與密文，不刪除。若已發布程式需要回復，以 Git revert 產生新提交，跑 baseline 後重新部署；不還原舊 Netlify deploy，也不回復正式資料快照。同步前端可用同樣的修復前進方式回到原 30 秒策略。

外部驗證仍需真實 LINE LIFF、提供者核可的測試帳號與通知收件確認；benchmark 不含網路、LINE、DB 延遲。不可用 stub、靜態分析或排程器模擬宣稱正式端到端驗證完成。
