# Supabase 產品化 P0 / P1：平台代管獨立商家專案

日期：2026-10-18。基準分支：`feature/productization-super-admin`，來源 SHA `96e23fd9041d1200a9de1ecfcc8e431a43f6ec12`。
決策已確認：**Supabase 由平台統一建立與管理；既有會員及業務資料保留、分階段遷移**。
本文件是執行契約，並非資料已遷移或隔離已通過的證明。

## 1. 第一性原理與邊界

| 面向 | 決策／不變條件 |
| --- | --- |
| 目標 | 一般管理員從 /admin/ 申請；總管理員在 /platform/ 只審核並修改八項功能授權；平台自動佈建專屬 Supabase Project；商家在自己的授權頁面設定 LINE；確認隔離後才開通商家工作台 |
| 身分 | 平台專用 LINE Login Channel 驗證 ID token（aud/iss/sub/exp）；平台操作者從伺服器對照資料庫手動核准的身分；每次敏感操作重新判斷授權 |
| 權限 | 總管理員可核准／調整功能，不編輯商家 LINE 秘密；商家管理員只能管理自己的專案及已授權模組；佈建憑證僅後端工作者可用 |
| 狀態 | application: pending → approved/rejected；tenant: pending_provisioning → active（驗證完成）或 suspended；provisioning job: queued → running → verified/failed/manual_review |
| 資料 | 控制平面只存申請、綁定、商家登記、授權、佈建狀態、加密密鑰參照、不可竄改稽核識別；業務表、Auth、Storage、Realtime、排程與 LINE 設定屬各商家資料專案 |
| 限制 | 舊系統仍使用單一 config.json 的 Supabase URL；不能直接將申請者接到原業務 API；不能取消現有業務服務、資料或授權 |
| 核心保證 | 商家 A 的任何憑證、URL 或物件 ID 不得讀寫商家 B；停權/撤銷功能後即使持舊 token 仍不能使用；總管理員不由遷移自動授權 |

架構：一個 **Platform Control Project**（平台擁有）+ 每個商家一個 **Tenant Data Project**（平台擁有）。
現有 `dbuquirnaskrwcamdxki` 暫作 **Legacy Data Project**，維持現有商家使用；舊系統資料不直接搬入 Platform Control Project。另有 `CalendarSystem` 專案，未經資源所有者確認不得拿來當新控制平面或商家沙盒。

成本門檻：每個 Supabase Project 有獨立 Postgres compute 計費。新增 Platform / Tenant 專案前由專案擁有者確認預算、地區、方案、命名和付款責任；未確認不得建立付費資源。

## 2. P0 已確認盤點（唯讀）

本輪查核時間：2026-10-18；Supabase ref `dbuquirnaskrwcamdxki`；GitHub ref 見文首。可重跑 SQL：`MemberWebsocket-dev/supabase/plans/p0_control_plane_inventory_readonly.sql`。

| 項目 | 實際數值／事實 |
| --- | --- |
| 公開業務基表 | 62 |
| 已啟用 RLS 的 public 基表 | 62 |
| public RLS policies | 3（未設定 policy 不等於 SQL 系統已可公開存取；仍須複查所有 API/RPC） |
| public 具 tenant_id/merchant_id/organization_id/shop_id 欄位 | 0 |
| public SECURITY DEFINER 函式 | 112 |
| 可由 anon／authenticated 直接 EXECUTE 的 public SECURITY DEFINER | 0／0 |
| anon／authenticated 使用 platform_private schema | false／false |
| Edge Functions | 32 |
| Storage Buckets（公開） | 2（0） |
| Supabase Realtime publication 表 | 1 |
| pg_cron extension | 已安裝 |
| 商家／商家申請 | 0／0 |
| super_admins 已存在／enabled | 1／0 |

Security Advisor 有 `rls_enabled_no_policy` INFO 告警：目前 67 張（含 private schema）表。此類表可能刻意只開放後端；若要改為用戶端直接查詢，必須增加實際擁有權校驗且不應把「TO authenticated」當租戶授權。
尚未確認：所有業務表的資料總量與 hash、Storage 物件數與 ETag、各排程工作指令、全部 API Auth/外部 LINE/DB seed、正式備份/PITR 可用性、Netlify 與外部服務密鑰清單。這些是 P0 剩餘門檻，不能用本輪的盤點數字聲稱完整驗證。

## 3. P1 邏輯資料模型（新建獨立 Platform Project；不修改舊庫）

所有實體都在 **不對 Data API 公開** 的 `platform_private` schema；撤銷 `PUBLIC/anon/authenticated` schema/table/sequence/function 權限，RLS 預設拒絕；只由受驗證的 platform-api/worker 使用最小權限後端連線；即使 `service_role` 也僅可讀取 `platform_operators`，**不能新增、啟用或修改 Root**，Root DML 只由另外授權的資料庫操作員執行。

| 實體 | 主鍵／唯一性 | 核心欄位與用途 |
| --- | --- | --- |
| `platform_operators` | `id uuid PK`、`line_user_id UNIQUE`；super_admin 有唯一部分索引 | `role='super_admin'`、`enabled=false`、`approved_at`、`approved_by`；**絕不 seed、複製啟用狀態或自動核准** |
| `applications` | `id uuid PK`、`slug UNIQUE`、`applicant_line_user_id UNIQUE` | 申請人、商家名稱、pending/approved/rejected、核准者、租戶 FK；批准建立 pending 商家，一個申請只能批准一次 |
| `tenants` | `id uuid PK`、`slug UNIQUE` | `owner_line_user_id`、`status`、`features`（沿用既有 8 布林功能）、`line_config`、版本、隔離證據與加密設定旗標 |
| `tenant_environments` | `tenant_id PK/FK`、`project_ref UNIQUE`（nullable，建立成功才填） | `region`、`stage`、`schema_version`、`verified_at`、`health_checked_at`；不能讓兩個商家共用同一 project_ref |
| `provisioning_jobs` | `id uuid PK`、`idempotency_key UNIQUE` | `tenant_id`、`operation`、`state`、`attempts`、`lease_until`、`error_code`、時間；不得將 PAT 或資料庫密碼存到錯誤或日誌 |
| `tenant_secrets` | `tenant_id PK/FK` | `envelope`（AES-256-GCM、tenant UUID 綁定 AAD）、`key_version`；管理 API token 不進商家資料庫 |
| `migration_runs` | `id uuid PK`、`tenant_id+dataset+run_key UNIQUE` | 來源/目標專案參照、dataset、快照點、游標、row_count/checksum、狀態；只存證據指紋，不存個資 |
| `requests` | `request_id uuid PK` | actor、operation、payload_hash、response 摘要；相同請求同結果，不同 payload 重用相同 ID 回 409 |
| `audit_events` | `id uuid PK` | actor、target、action、result、request_id、occurred_at；敏感事件 append-only，不存 token、密碼、原始密文 |

**與舊控制平面的差異**：舊 `super_admins.admin_id` FK 指向舊 `public.admins`；獨立 Project 沒有該 FK，不能照搬。新 Project 改用 `platform_operators` 與手動核對 LINE 身分；在 platform-api 完成雙資料源適配、撤銷測試前不可切讀新 Project。舊 `platform_private.tenants.features` 是授權真相來源；本輪不另外建立第二份可衝突的功能授權表。新 Project 的 `platform_private.tenant_secrets` 加密金鑰需另外規劃轉移與輪替，不能用複製密文卻丟失原 key 的方式遷移。

完整 schema 參考稿：`MemberWebsocket-dev/supabase/plans/p1_control_plane_schema_sandbox_ONLY.sql`，**只可用於全新隔離測試專案**。部署正式控制平面前，需用 `supabase migration new` 產生正式版本遷移並完成測試、審查。

## 4. 授權矩陣

| 操作 | 訪客 | 申請中管理員 | 已核准商家 | 總管理員 | Provisioner |
| --- | --- | --- | --- | --- | --- |
| 查自己的申請狀態 | — | 是（LINE sub 比對） | 是 | — | — |
| 送出申請 | — | 是（平台 LINE 驗證） | — | — | — |
| 核准/調整八項功能權限 | — | — | — | 是（DB enabled） | — |
| 設定自己的 LINE channel/LIFF/secret | — | — | 是（租戶 owner + 狀態） | 否 | — |
| 建立/升級商家 Supabase 專案 | — | — | — | 否（只核准） | 是（服務憑證） |
| 存取商家業務資料 | — | — | 只可存取自己且已開通的功能 | 否（不繞過隔離） | 經審計的佈建範圍 |
| 操作平台 Root 手動授權 | — | — | — | 不可自我授權 | 否（僅經授權的資料庫操作者） |

平台 LINE ID token 只能證明其 Channel/Provider 下的使用者；商家 LIFF 屬不同 Provider 時須另做受信任的身份綁定，不可用同一 UID 假設同人。身份綁定應具有 owner 證明、雙端驗證、一次性 nonce、審計與撤銷，未驗證則 fail-closed。
根權限查核不信任瀏覽器傳入 role、tenant ID、feature list；不以使用者可編輯的 JWT user_metadata 作授權依據。

## 5. 狀態機和 P1 佈建邏輯

1. `POST /platform/applications`：驗證平台 LINE ID token，資料庫唯一約束防重複，僅寫入 pending。
2. `POST /platform/applications/{id}/approve`：已手動授權 root 核准八項布林功能；同交易建立 `pending_provisioning` tenant 與 `queued` job（此步 **不直接建立 Supabase 專案**）。
3. Provisioner 從工作佇列取得單筆租約；預檢該操作尚無既存 project_ref，且平台成本批准文件有效。
4. 使用受限 scoped PAT / 具體 Organization ID 呼叫 Management API 建立專案。回應、重試與持久化分階段；成功後存 project_ref；若遠端成功但本地超時，先按可驗證專案標記/名稱/操作紀錄對帳，無法確認則標示 manual_review，**不可直接再建立第二個**。
5. 套用明確版本的 schema / Edge Functions / Auth / Realtime / Storage / Cron，且將唯一商家 context 與後端金鑰安全配對。任何步驟失敗保留專案與錯誤狀態，禁止啟用。
6. 實際測試商家隔離、授權/撤權、全業務模組、LINE 身份/憑證與回滾；將 checksum、schema_version、healthcheck 記錄於 job。
7. 只有同時符合 `tenant_environments.stage='verified'`、`verified_at`、`isolation_verified_at`、`credentials_configured`、所要求功能的 LINE 設定與最新功能／資料 API 測試通過，才允許 tenant → active。任何未通過必須保持封鎖。
8. 停權或降權即時在伺服器撤銷 route/功能權限；舊 session、跨租戶 request、Realtime 訂閱與已排程通知必須重新檢查、拒絕或取消。

## 6. 逐步遷移與切換（不刪資料）

| Phase | 來源 → 目標 | 實施步驟 | 放行條件／回復 |
| --- | --- | --- | --- |
| P0 inventory | 舊業務專案唯讀 | Schema/函式/Edge/Storage/Realtime/Cron/數量/外部設定/權限／備份清單及基線快照 | 紀錄讀取權限、來源 ref、查核時間；有阻礙不視作完成 |
| P1 control setup | 新 Platform Project | 成本核准→建立空專案→私人 schema + 最小權限→控制 API dual-read shadow mode→申請／審核 E2E | 先 A/B 合成帳號；root 由資料庫操作者明確且獨立授權，預設 0 root；回復僅將 platform endpoint 指回舊庫，**不刪新庫** |
| P2 first sandbox tenant | 新 tenant 測試 Project | versioned schema/Functions/Storage/Auth/Realtime/Cron→合成資料→AC 跨商家隔離→LINE sandbox | 所有必要安全與 E2E 測試完成；失敗保留為 quarantined |
| P3 legacy data migration rehearsal | 舊單一商家 → 新隔離商家專案 | 先可回復備份與 PITR 檢查；匯出一致性快照；從 FK 依賴排序，導入資料與 Storage 物件；比對 count/hash/FK／金鑰／排程；重放變更期間雙寫或短暫寫入凍結（需先決定） | 驗證 row count+hash+商業不變條件、流量切換前壓測，失敗仍使用舊庫 |
| P4 canary/read switch | 先測試商家，後現有商家 | /tenant/bootstrap 受伺服器簽名與授權的 tenant resolver；所有 API、jobs 與 LINE 都採 project-scoped server credentials；少量分流，觀察一致性 | 雙重 healthcheck、權限測試、審計和回滾開關；保留舊庫供回切 |
| P5 legacy retirement | 確認長期運作後 | 移除單一商家 URL 與舊維護程序引用、停止 legacy 雙寫；設定資料保留期 | 需另行核准、備份可還原、法規保留與流量歸零；**不自動刪除任何正式資料** |

**額外防護：Supabase 的「Restore to a new project」可一併複製 pg_cron／pg_net 等外部操作；複製完成後工作可能立刻運作。未事先隔離外部通道與通知前，不得以生產備份直接複製成測試環境；必要時採受控邏輯匯入，且需處理 Vault 加密根金鑰不會自動遷移的限制。**
**重要：備份不等於 Storage 物件備份。** Supabase DB backup 的 Storage 物件內容必須另行備份與驗證；Auth、Edge Function、密鑰、外部 LINE channel 設定也必須單獨盤點與重建。不得單靠 schema/data SQL dump 宣稱完成商家遷移。
**DNS / LIFF**：既有 LINE 回跳/LIFF URL/Netlify 枝節服務保持原樣至 staging 驗證，不能提前改正式設定。

## 7. P0/P1 驗收條件和測試證據契約

| AC | Given / When / Then | 測試層／執行工具 | 此輪 |
| --- | --- | --- | --- |
| AC-P0-001 | Given 舊資料庫，When 唯讀盤點，Then 產出 62/112/32/2 等可重跑基線，不修改任何資料 | SQL SELECT、API lists | 盤點已執行 |
| AC-P0-002 | Given 含平台私有 schema 的 DB，When 查詢角色權限，Then anon/authenticated 不能使用它或呼叫 public definer | pg catalog 唯讀查詢 | 已執行 |
| AC-P0-003 | Given 既有資料，When 準備遷移，Then 能還原資料庫及 Storage 樣本、可重現快照 hash | staging 備份還原演練 | 未執行，阻擋資料切換 |
| AC-P1-001 | Given 新空白測試 Project，When 執行 schema migration，Then 表與唯一/狀態/權限約束一致且無 root seed | psql / Supabase CLI / SQL integration | 尚未執行 |
| AC-P1-002 | Given 任意訪客或管理員，When 直接讀寫 private schema/竄改 role/feature/tenant ID，Then 失敗；錯誤不透露 secrets | API + DB roles + 安全負向 | 尚未執行 |
| AC-P1-003 | Given 手動核准 root 且另有非 root，When root 核准指定八項功能，Then 只授權該 tenant，並記稽核；停權後舊 token 拒絕 | SQL+API+browser E2E | 尚未執行，需 root 測試帳號 |
| AC-P1-004 | Given 相同 request_id 重送或併發核准，When 寫入，Then 只有 1 tenant + 1 job，不遺失審計 | 真實 PostgreSQL 多連線交易 | 尚未執行 |
| AC-P1-005 | Given 建立專案的 API 失敗/429/timeout/已成功但回應遺失，When retry/reconcile，Then 不建立重複專案；秘密不記錄 | Provisioner mock 與 sandbox Management API | 尚未執行 |
| AC-P1-006 | Given sandbox tenant 未通過隔離或 LINE 配置，When 嘗試 active，Then DB/server fail-closed | SQL trigger + API | 尚未執行 |
| AC-P1-007 | Given 商家 A/B，When 讀寫對方 API/Storage/Realtime/Jobs 及停權，Then 全部拒絕且無跨資料 | 兩個 sandbox Projects E2E | 屬 P2，不得先宣稱驗證 |
| AC-P1-008 | Given 控制平面切換失敗，When 切回 legacy 控制 endpoint，Then 舊商家業務服務不中斷且不丟失申請／審計 | staging rollback drill | 尚未執行 |

**必跑基線**：格式/lint/型別/build、單元、SQL/PGlite 整合、真實 PostgreSQL 併發、DB migration fresh+upgrade+rollback、Chromium E2E、越權安全負向、依賴安全檢查、所有既有測試、建置後冒煙。第三方 LINE/Management API 服務須分別用 stub 故障測試及正式 sandbox；stub 通過不代表外部整合通過。
每項報告記錄：git SHA、測試 Project ref（不得含 secrets）、UTC 時間、命令、退出碼、通過／失敗／跳過、log/artifact URI；零案例或必要案例跳過不算通過。

## 8. P0/P1 可執行步驟與安全 Gate

P0：
1. 執行附屬 read-only SQL，保存 JSON/CSV 輸出和 query 時間；GitHub 對照 32 Functions 的實際 slug、既有函式、部署版本與 migration 文件差異（**數量應動態計算，不能假設常數**）。
2. 用服務提供者備份清單／PITR 設定確認可恢復點；在測試專案演練還原，另匯出 Storage 物件與 hash，不接觸正式寫入。
3. 建立 Functions → tables/functions → bucket/realtime/cron/LINE channel 的依賴表，標示尚未調查的權限入口。舊業務全量回歸為 P2/P3 強制基線。

P1：
1. 審核平台 Project 預算/Region/plan、專案所有權和最小權限 scoped PAT，建立獨立 Platform sandbox，**不使用已存在的 CalendarSystem**。
2. 使用已安裝的 Supabase CLI 檢查 `supabase --help`、`supabase migration new --help` 後建立新遷移；以本計畫 schema 參考稿為來源，僅套用到新空白測試 Project。
3. 將舊 platform-api 變為抽象 repository；逐步切入新的 Platform DB。不能將現有依賴 `public.admins` 的 super_admins FK 一併複製。初次 root 仍一律 disabled/empty，只能由已驗證的 SQL 操作者明確授權。
4. 先跑 8 個 P1 AC 及全專案基線，保留完整證據；才於 staging 驗證 dual-read/shadow-write（以 request_id 對帳，禁止不同表各自主寫雙份而無交易補償）。
5. P1 確認完成前，原 config.json、原 API、LINE/Netlify 預覽與現有資料完全不切換。

## 9. 執行與回復

- 原網站構建：`node scripts/build-site.mjs`。
- 既有單元：`node --test MemberWebsocket-dev/tests/*.test.js`。
- SQL integration：`npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration`，再執行對應 test（請先確認當前 lockfile）。
- 真實瀏覽器：`npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser`，再 `npm test --prefix MemberWebsocket-dev/tests/browser -- product-platform.spec.cjs`。
- CLI migrate 及 db reset 只能針對 **新空白測試專案/本地資料庫**；絕不可在正式 project 直接執行 db reset。
- P1 控制 API 故障時：停止 Provisioner/影響新申請的寫入，將控制頁導回舊平台後端；保留兩邊申請/稽核事件待對帳，**禁止直接刪除**。正式商家流量此階段本來就應維持舊業務專案。
- 災難回復一律先走 staging 完整演練並記錄 RPO/RTO，才允許實際切換。

## 10. 本輪交付邊界

本輪只進行正式 Supabase 唯讀盤點、規劃文件及未部署的 sandbox schema 參考檔。尚未建立新 Project、寫入正式 DB、改 Netlify、改 LINE、執行完整專案測試或授權任何總管理員。**P1 屬準備中，不能聲稱驗證完成或可上線。**
