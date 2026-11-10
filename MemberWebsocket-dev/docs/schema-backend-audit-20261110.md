# 前後端資料契約與 Supabase 錯誤修復

## 本輪結果

已完成可重現修正與本機驗證；最終 PostgreSQL、Chromium、Edge、依賴及發布結果以本 PR 的同 SHA GitHub Actions 與部署紀錄為準。未完成的外部登入驗收不計為通過。

## 第一性原理摘要

| 項目 | 契約與決策 |
|---|---|
| 目標 | 既有與新建商家均能讀寫提醒文字、套用票券服務組合與活動加贈結算 |
| 身分 | 沿用 LINE ID token、既有會員／管理員驗證及工作階段規則 |
| 權限 | Edge service role 使用商家 schema；不增加 anon/authenticated 存取權 |
| 狀態 | 保留現有商家開通流程、會員狀態、預約與票券生命週期 |
| 資料 | 補齊缺少欄位／範本函式及約束；不修改會員、點數、預約或票券交易資料 |
| 限制 | 不以 public 當商家資料替代來源；保留所有既有功能與無關遠端修改 |
| 決策 | 採局部且可交易回復的增量 migration，沿用既有 installer 與範本 |
| 失敗 | 未登記 schema 拒絕；來源函式／欄位／trigger 缺失時整筆 migration 中止 |

事實：初始版本為 `c1e2a7f`，最終整合基準更新為 `178a34d`。兩者之間的點數轉贈及 canonical API 修正已由另一筆變更合併，本輪保留該實作並增加撤權／過期及未知動作負向驗證。

## 查核與根因

| 查核 | 實際發現 | 處理 |
|---|---|---|
| 1,535 個 public／商家欄位 | 共用欄位型別及可空性未見差異；商家缺少 `booking_settings.reminder_message` | 修補既有商家並將欄位安裝掛入日後 provisioning |
| 81 個後端來源檔 | 137 個不同 literal RPC 名稱與 189 組物件參數可對應 live catalog | 動態 RPC 另依既有 adapter 處理；靜態掃描不等同執行驗收 |
| 新商家 JSON 範本 | 兩個 `required_service_groups` 及 `calendar_bonus_details` 欄位、相關函式／約束／trigger 未同步 | 只同步這三項已確認契約；保留其他範本項目與既有商家資料 |
| Supabase 過去 24 小時紀錄（初查） | 25 筆 `42703 event_tickets.required_service_groups`，最後為 2026-11-09 17:39 台北時間 | 已由既有 17:46 migration 修補；不能再當成本輪尚未修復的錯誤 |
| `member-growth-api` 403 | 點數轉贈三個 action 未對應商家功能 | 遠端 `b8cfca8` 已修復；本輪不覆寫其實作 |
| 401／429／410 | 含無憑證拒絕、速率限制與已停用測試 API | 不以解除權限或限流處理這些正常拒絕 |
| 安全／健康 advisors | 初查健康無提示；RLS 無 policy 的私有表維持拒絕，另有既有 pg_net 位置警告 | 不為清除提示而開放會員資料或搬動無關 extension |

掃描中的 `price_version` 來源是 `withBookingPrices` 轉向 `booking_services_priced` view；`notice_outbox` 是商家私有表；`member_invitation_` 是動態 RPC 前綴。這些均不是缺欄位或缺函式的結論。

## 變更與驗收

| AC | Given／When／Then | 測試與層級 |
|---|---|---|
| AC-001 | Given 有效商家且開通點數，When 使用三個轉贈動作，Then 使用 points 授權；關閉、停權、過期或未知動作被拒絕 | `tests/business_policy.test.js`，Node 行為回歸 |
| AC-002 | Given 提醒範本 migration 後才建立的商家，When 升級或重新安裝，Then 欄位可用、1–400 字、保留自訂文字及時間戳；未登記 schema／瀏覽器角色拒絕 | `booking_member_reminder.cjs`、`postgres/reminder-message.cjs`，PGlite／PG17 |
| AC-003 | Given 舊商家及範本，When 按版本順序遷移並建立新商家，Then 三個欄位、服務組合求值、加贈結算回傳及私有權限一致 | `business_provisioning_contract.cjs`、`postgres/provisioning-contract.cjs` |
| AC-004 | Given 已建立的完整專案基線，When 交付候選 SHA，Then 所有必要 CI 成功才可合併／發布 | 原三組 workflow 與 Publish verified platform preview |

提醒案例以實際資料庫確認重跑保留資料、0／400／401 字界線與 DDL rollback。開通範本案例按檔名排序套用 migration，可攔截來源 migration 晚於修補 migration 的錯誤。新商家案例使用實際基底結算與帳本，確認 2 點服務點數加 3 點活動加贈、資料落盤、重試拒絕及跨商家無副作用；不代表外部 LINE 已驗證。

## 測試證據

| 檢查 | 命令／工具 | 本機實際結果 |
|---|---|---|
| 原始 regression | `node --test MemberWebsocket-dev/tests/*.test.js` | 1,356 通過、0 失敗、0 跳過（原始基準） |
| 整合後 regression／build contracts | `TMPDIR=<工作目錄> node --test MemberWebsocket-dev/tests/*.test.js scripts/*.test.mjs` | 1,509 通過、0 失敗、0 跳過（更新基準後） |
| 兩組新契約與既有提醒案例 | `node --test .../booking_member_reminder.cjs .../business_provisioning_contract.cjs` | 9 通過、0 失敗、0 跳過（更新基準後） |
| DOM／SQL | 原 workflow 的全部 integration 命令 | 本機初輪日誌已保留；最終同 SHA 由 CI 重跑 |
| 相依套件 | 兩組 `npm audit --audit-level=low` | browser／integration 均 0 vulnerabilities |
| RED 證據 | 轉贈 mapping、提醒欄位、新商家三個欄位、migration 排序 | 均在修正前實際失敗；保留於工作紀錄 |
| PG17／Chromium／Deno／wiring／發布 | GitHub Actions 完整基線 | 結果、時間、最終 SHA 與 run URL 附於 PR；未執行者不當通過 |

最初本機 scripts 測試因受限環境沒有 `/tmp` 而失敗；改用可寫的 `TMPDIR` 後重跑全數通過，沒有變更產品或測試斷言。

## 程式碼品質與效能

沿用既有 schema installer，僅加入私有且驗證商家歸屬的 reminder 欄位安裝函式。既有商家只執行補欄位，不重裝或覆蓋其後來更新的 booking／receipt RPC。範本只替換明確列舉的函式與約束，不建立通用同步框架。

本輪最終 diff 不修改線上請求程式，轉贈 mapping 已由上游合併。資料庫變更只在 migration／商家開通時執行，不增加每次會員請求的查詢數。未宣稱 API 加速。初期同機 7 組、每組 100,000 次一般 action 的量測範圍為基準 28.7–50.4 ms、候選 31.5–48.9 ms，波動重疊，不能視為效能改善。

## 已知限制與回復

- GitHub Projects 讀取回傳 403；未據此變更卡片狀態。程式庫與部署獨立查核。
- 真實 LINE 登入、實際會員轉贈與提醒發送未在正式會員資料上進行破壞性測試；CI fixture／stub 不代表 Provider 真人驗收。
- 既有 pg_net schema advisory 不由本輪搬動。[官方說明](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)。

啟動／建置沿用 `node scripts/build-site.mjs`。兩筆 migration 由部署工具依序套用；補欄位的預設文字為「請準時到場；如需調整請至預約頁操作。」。

回復採 forward fix：先還原候選 commit 並重新完整 CI，新增已審查 migration 還原變更前的 installer definition／template snapshot。保留已新增欄位與商家後續自訂文字，不直接 drop 欄位、刪會員或反向重跑舊 migration。DDL rollback 已在隔離資料庫驗證。
