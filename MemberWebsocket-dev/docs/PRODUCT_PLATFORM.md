# 獨立商家產品化：控制平面第一階段

本分支建立總管理員控制台、商家管理員登記、八項功能設定與 LINE 憑證安全保存。
**這不是已完成的多租戶會員系統。新增商家維持 `pending_provisioning`，目前不能登入既有業務工作台。**
業務 API、Realtime、Storage、排程與 LINE 推播尚未接上商家隔離，功能設定目前是待啟用設定。
不得藉由手動填入 `isolation_verified_at`／`isolation_version` 跳過驗收。

## 已確認事實與工作範圍

| 類別 | 內容 |
| --- | --- |
| 需求 | 使用者已確認每位管理員代表獨立商家，會員與業務資料完全隔離。 |
| 來源版本 | develop `b04486a557ae35c126531cdd1bdb15a22667be5d`。 |
| 現況 | 2026-10-17 唯讀盤點：既有 public 業務表沒有 tenant_id，112 個 SECURITY DEFINER 函式，僅一位啟用中的管理員。 |
| 第一階段 | 一個總管理員登記商家管理員，設定會員卡、集點卡、活動票券、營運日曆、整合中心、預約、測試、使用紀錄。 |
| 身分 | 總管理員獨立 LIFF `2012065297-VunxFBj8`，後端只驗證 Login Channel `2012065297`；每次 API 與資料庫操作重新確認總管理員資料列。 |
| 資料 | 私有 schema 保存平台設定、加密憑證、操作識別與稽核，無一般使用者讀寫權限。 |
| 狀態 | 新增為 pending_provisioning；本階段可停用為 suspended，沒有公開啟用／復權端點。 |
| 相容性 | 不變更現有商家的會員、票券、預約、LINE 設定與授權邏輯，不將新管理員寫入 public.admins。 |
| 待完成 | 商家業務環境佈建、路由、商家登入、八項權限於所有 API 強制執行與跨商家隔離。 |

核心不變條件：一般管理員不能呼叫平台 RPC 或讀取平台表；憑證不回傳瀏覽器、不進入稽核；未完成隔離的商家無法被設定 CRUD 啟用。

## 架構決策

| 方案 | 可驗證性 | 維護成本／安全性 | 與現有系統相容性 |
| --- | --- | --- | --- |
| 共用資料表 + tenant_id／RLS | 可逐表與跨租戶外鍵測試；須同步修正所有提升權限函式 | 長期管理集中，但 SECURITY DEFINER／service_role 容易繞過 RLS，改造範圍最大 | 需重做全域唯一約束、單例設定、所有 RPC 與資料搬遷 |
| 每商家獨立 schema | 可檢查表、函式、觸發器、Storage 與排程引用是否跨商家 | 適合沿用現有完整業務模型，但需要版本化佈建與升級工具 | 可保留既有資料模型；仍需重寫所有 public 硬編碼引用與租戶路由 |
| 每商家獨立 Supabase 專案 | 隔離邊界最明確 | 每商家新增服務成本、密鑰與部署管理負擔 | 能沿用業務程式，但需平台管理 API、成本授權與自動佈建 |

本階段先把控制平面分離，不對尚未完成的業務隔離做出上線保證。
後續優先驗證獨立 schema 方案；若 RPC、通知或 Realtime 無法維持完整隔離，再選獨立專案。
不得以替換字串後直接複製所有 SECURITY DEFINER 函式視為隔離完成。

## 權限、設定與憑證

- `platform_private.super_admins` 以 singleton=true 主鍵保證最多一個總管理員。
- 遷移只在既有啟用管理員恰好一位時，將該管理員登記為總管理員。多位或零位時不自行挑選，須由專案擁有者明確指定。
- 後續 `20261017140939_platform_line_identity.sql` 將平台 LINE User ID 獨立保存，初始採用該擁有者的既有 UID。同一 Provider 可以沿用 UID；不同 Provider 須由專案擁有者明確綁定新 UID，登入者不會自動升權。擁有者原管理員資料列停用，或平台 enabled=false，都立即撤銷總管理員存取。
- 平台身分驗證只向 LINE Verify ID token API 提交 token 與固定的 `client_id=2012065297`；驗證 aud、iss、sub、exp、iat。舊管理端 Channel token 即使屬於總管理員本人也拒絕；商家維護模式與會員單一登入限制不會套用到平台登入。
- 普通管理員即使在 public.admins 為 active，也無法存取總管理員控制台。
- 商家代碼、管理員 LINE User ID 建立後不可直接換人；轉移身分需要獨立的撤銷／驗證流程。
- LINE Login Channel 與 Messaging API Channel 應屬於同一 Provider。表單檢查格式與 LIFF 前綴，不宣稱已驗證 LINE Developers 的設定、token 有效性或 Provider 關聯。
- 新增時需 adminChannelId、memberChannelId、messagingChannelId、管理端 LIFF ID、開放功能對應的 LIFF ID、Channel access token 與 Channel secret。
- token 與 secret 使用 Web Crypto AES-256-GCM、隨機 96-bit IV，且以商家 UUID 綁定 additional authenticated data；密鑰由 Edge secrets 提供。
- 編輯時憑證留空保留原值，更新需同時提供兩項憑證；瀏覽器沒有讀回或解密功能。
- 所有寫入含原子樂觀鎖、request ID 與交易內稽核；相同操作重試不重複建立。不同內容重用同一 request ID 回傳 409。
- 設定不放在 public 業務表，避免既有「清空非管理員資料」連帶移除平台資料。

## 驗收與測試對照

| 編號 | Given / When / Then | 測試 |
| --- | --- | --- |
| AC-001 | Given 非總管理員或已被撤銷的總管理員，When 查詢／寫入，Then 回傳 403；偽造 actor 直接呼叫 RPC 亦拒絕 | product_platform.test.js；integration/product_platform.cjs；browser/product-platform.spec.cjs |
| AC-002 | Given 總管理員，When 設定八項布林功能，Then 精確保存；缺項、字串、額外 role/status 欄位拒絕 | 單元 + SQL + Chromium 建立／編輯 |
| AC-003 | Given 新商家，When 缺憑證、啟用功能無 LIFF、Channel 前綴錯誤，Then 不建立資料 | 單元驗證 + SQL 交易 |
| AC-004 | Given 有效商家設定，When 保存／查詢，Then 憑證為密文、不進入回應或稽核；換商家 UUID、密鑰或竄改密文皆解密失敗 | 真實 Web Crypto + SQL + 瀏覽器 |
| AC-005 | Given 逾時或版本競爭，When 重試／舊版本寫入，Then 單筆商家、單筆對應稽核，不覆蓋新版本 | handler + PGlite；Chromium 提交成功後丟失回應 |
| AC-006 | Given 新商家未完成資料隔離，When 嘗試啟用，Then DB constraint 拒絕；舊業務清除不影響控制平面 | SQL + guard 單元測試 |
| AC-007 | Given 兩個完整商家環境，When 執行八項功能、跨商家 ID、Realtime、Storage 與排程，Then 完整隔離且功能關閉時 API 拒絕 | **尚未實作／未通過：本階段不可開通新商家** |
| AC-008 | Given 各商家實際 LINE 設定，When 真實登入與推播，Then 身分、Provider 與憑證有效且不跨商家 | **未執行：需隔離環境與 LINE 測試設定** |
| AC-009 | Given 平台專屬 LIFF，When 正確 Channel + 已綁定總管理員登入，Then 允許；舊管理端 Channel、未授權使用者、過期 token、LINE 服務異常與缺 LIFF 設定皆拒絕；更換 Provider UID 後舊 UID 立即失效 | product_platform_auth.test.js；真實 verifier + handler + PGlite；Chromium |

PGlite 執行真實 SQL、角色權限與資料結果，仍不是遠端 Supabase 或多連線 PostgreSQL 併發驗證。
瀏覽器走真實前端、LINE 驗證器、handler、SQL 與加密流程，只有 LINE HTTP 回應以合成帳號替代；不能計為真實 LINE 整合通過。

## 執行方式

既有命令：

```bash
node scripts/build-site.mjs
node --test MemberWebsocket-dev/tests/*.test.js
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration
node --test MemberWebsocket-dev/tests/integration/product_platform.cjs
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser
npm test --prefix MemberWebsocket-dev/tests/browser -- product-platform.spec.cjs
```

控制台路徑：`/platform/`（獨立於 `/admin/`）。舊 `/admin/platform/` 僅保留 HTTP 301 轉址至 `/platform/`；不再保留舊目錄檔案。總管理員從 `https://liff.line.me/2012065297-VunxFBj8` 開啟，使用專屬官方帳號所連結的 LINE Login Channel。公開設定 `platformLiffId` 僅供此控制台使用，缺少或前綴錯誤會停止登入，不退回商家 `adminLiffId`。

目前發布分支為 `Integrated-Marketing-Platform`，固定網址為 `https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/platform/`。`publish-platform-preview.yml` 在同一提交的完整測試、建置與票券政策檢查成功後發布相應分支 alias；根目錄導向總管理員頁。舊 `feature/productization-super-admin` 分支保留 `platform` alias。流程不使用 `--prod`，既有正式站維持 develop 版本。

平台使用獨立的 LIFF 初始化與登入流程，外部瀏覽器未登入時呼叫無參數的 `liff.login()`，由 SDK 使用已設定的 Endpoint URL；不套用商家管理端的強制重新登入與 `member_system_reauth` 回跳參數。每次請求仍由後端驗證專屬 Channel 與總管理員資格。

LINE Developers 需設定此 LIFF 的 Endpoint 為目前發布分支上方的完整 HTTPS URL，Scopes 至少包含 `openid`、`profile`，並確認 Login Channel 已連結總管理員官方帳號。不得將 LIFF 指向尚未發布此功能的正式站。商家自己的管理端 LIFF 設定保存於商家資料中。

若總管理員的新 Channel 屬於不同 Provider，先從該 Channel 的 Basic settings → Your user ID 取得擁有者的 UID，透過專案擁有者權限確認後綁定 `platform_private.super_admins.line_user_id`，不可使用使用者自行提交的 UID。保留 `admin_id` 指向原擁有者，以維持撤銷機制。範例只供擁有者在已驗證的隔離環境執行，請替換所有占位值：

```sql
begin;
update platform_private.super_admins
set line_user_id = '<總管理員在新 Provider 的 U 開頭 UID>'
where singleton and admin_id = '<已核對的原擁有者 admin UUID>'::uuid
  and line_user_id = '<已核對的目前綁定 UID>'
returning admin_id, line_user_id, enabled;
-- 確認恰好一列且為擁有者，再 commit；不符則 rollback。
```

此操作不新增商家管理員、不修改會員資料。未完成身分核對時保持拒絕登入。LINE 身分與 Provider 規則參考：[User ID](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)、[Verify ID token](https://developers.line.biz/en/reference/line-login/#verify-id-token)。
正式部署前，先在隔離的 Supabase 環境驗證這份新遷移及 `platform-api`，不能直接對現有會員資料執行破壞性測試。
新 Edge Function 沿用原系統的自訂 LINE 驗證方式，需要關閉 Supabase gateway JWT 驗證並由 handler 驗證 LINE token。
設定精確的 ALLOWED_ORIGINS；不使用萬用來源。

伺服器需要 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。平台 Channel 固定為 `2012065297`，不讀取既有商家的 `LINE_ADMIN_CHANNEL_ID`。
`20261017151624_platform_credential_vault.sql` 在 Supabase Vault 建立一次性的 32 隨機位元組 Base64 金鑰；只透過 service_role 可執行的 SECURITY INVOKER RPC 供後端讀取，不擴大既有 Vault 存取權限，也不在遷移檔或工具回應輸出明文。Vault 功能以實際 Supabase 驗證，PGlite 不模擬 Vault 加密。
若原本已有 `PLATFORM_CREDENTIAL_ENCRYPTION_KEY`，優先沿用該環境金鑰。不得為了改用 Vault 而刪除既有環境金鑰；需先完成重加密與驗證。也可由 `openssl rand -base64 32` 產生後設定於 Edge secrets。
不得放入 config.json、Netlify 公開建置變數或版本控制。
**已存密文仍使用原密鑰；不可直接換掉或刪除。輪替需要雙密鑰讀取、重新加密與完成驗證。**

## 回復與剩餘工作

前端回復可 revert 本分支提交。資料庫回復腳本在 `supabase/rollback/product_platform_control_plane.sql`，
會刪除本階段新建的平台設定與加密憑證；先備份並由操作者明確執行，腳本不變更原有會員業務資料。
回復腳本移除金鑰讀取 RPC，但保留 Vault 金鑰，以供加密備份復原；不可在仍有相關密文時刪除。

接續開發順序：

1. 建立可重建的完整業務 schema 基線及 A／B 商家隔離資料環境。
2. 實作版本化 schema 佈建與升級，逐一消除 public、Storage、Realtime、cron／通知的全域引用。
3. 所有 Edge Function 以伺服器解析的商家上下文取得資料與 LINE 設定；租戶參數不能自行提升權限。
4. 八項功能逐一接入 API 權限與前端入口；稽核、測試、清除資料也必須受商家隔離。
5. 跑 AC-007／008、全專案測試與隔離環境升級／回復驗證後，才新增啟用商家的控制台操作。

## 第二階段：管理員主動申請與 LINE 自助設定（2026-10-18）

- 管理員從 `/admin/` 的「申請商家管理員／查看審核進度」連結，進入平台專用 LINE LIFF `/platform/`。此 LIFF 由固定的 `2012065297` Login Channel 驗證，與舊管理端 LINE Channel 分開。
- 平台根據每次 LINE ID token 驗證結果分流：具有效總管理員權限者可看申請列表、勾選八項功能核准；一般申請人只能提交商家名稱與代碼、查看自己的申請進度。
- 申請待審核時**不建立商家**；批准後在同一交易建立 `pending_provisioning` 商家，預設空 LINE 設定、憑證未配置，並寫入申請狀態、審核者與稽核事件。批准採 request ID 冪等操作。
- 核准商家的擁有人可設定**自己的** LINE Login Channels、LIFF IDs、Messaging access token 和 channel secret。Token 與 secret 用現有 AES-GCM 加密流程保存，不在 API 回應、日誌或 UI 回填。
- 管理員不能設定任何自身功能勾選值、角色、商家狀態、租戶 ID 或核准資料；身分由後端重新驗證並以資料庫 `applicant_line_user_id` 和商家 `owner_line_user_id` 綁定。總管理員可日後透過既有「編輯設定」調整核准功能。
- LINE Provider 之間的使用者 ID 可能不同。本階段平台申請人 UID 用於管理控制平面；後續商家端 LINE UID 的對應仍須在獨立資料環境驗證與佈建階段明確確認，不能假設不同 Provider 下的 UID 相同。
- **重要限制：審核通過不自動解鎖既有 `/admin/` 的業務資料。** 原有 API 與多個 `SECURITY DEFINER` 函式尚未完整租戶化，因此保持安全阻斷；完成租戶級資料、RPC、Storage、通知和 Realtime 隔離後才可啟用。

| 驗收 | Given／When／Then | 測試 |
| --- | --- | --- |
| AC-010 | 申請人以平台 LINE 驗證進入／提交名稱代碼／系統顯示 pending 且未建立商家 | `integration/product_platform.cjs`、`browser/product-platform.spec.cjs` |
| AC-011 | 總管理員看到待審核申請／核准八項權限／建立 pending_provisioning 且兩次重試不重複 | 同上 |
| AC-012 | 經核准管理員設定自己的 LINE／伺服器加密保存／無法修改功能、角色和隔離狀態 | 同上 |
| AC-013 | 未登入、非擁有人、停權商家、匿名資料庫角色嘗試存取／皆拒絕 | `integration/product_platform.cjs` |

資料遷移：`20261017164510_platform_admin_applications.sql`。資料保留原則：拒絕申請可重新提交；已核准申請留存以保留身份與稽核關係。完整測試證據以 GitHub Actions 執行結果為準，尚未驗證的層級不得計為通過。
