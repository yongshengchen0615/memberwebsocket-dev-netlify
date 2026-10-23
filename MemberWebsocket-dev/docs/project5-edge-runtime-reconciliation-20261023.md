# Project #5｜SEC-03 Edge Function 來源／部署核對（2026-10-23）

> 工作卡：[#34](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/34)（P0 安全）、[#47](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/47)（QA 證據）。此文件為**唯讀核對證據**，不是後端發布許可、功能驗收報告或部署申請。

## 固定版本與範圍

- 來源：`Integrated-Marketing-Platform@6892efd30a905fd70b0735ca86175eedc08d3f45`。
- 遠端：Supabase `MemberWebsocket-dev`，project ref `dbuquirnaskrwcamdxki`，2026-10-23（Asia/Taipei）透過管理連接器讀取 Edge Functions 版本及實際打包的入口檔。
- 前端分離：Netlify branch deploy `6ada0858f76de743523c54cd` = `ready`，`commit_ref=6892efd...`；其部署報告明列 **No functions deployed**。因此前端 ready 不能證明 Supabase 已同步。
- 核對方法：逐個從 GitHub 指定 SHA 讀取 `MemberWebsocket-dev/supabase/functions/<slug>/index.ts`，再從 Supabase `get_edge_function` 取回 `functions/<slug>/index.ts`（部分部署使用 `<slug>/index.ts` 路徑），以完整文字嚴格相等比較。**只證明入口檔相同／不同，不表示共用依賴、部署環境變數、資料庫、外部 LINE Provider 或商家資料相同。**

## 本輪精確讀回（4/4 個入口完成核對）

| Function | Supabase ACTIVE 版本 | 入口檔與來源完全一致 | 來源身分／授權契約（靜態核對） | 未驗證項 |
| --- | ---: | --- | --- | --- |
| `fixed-ticket-automation` | v11 | **否**（來源 18,391 字元；部署 18,430 字元） | 來源入口有 `isVerifiedLineIdClaim`、原始 token 型別／長度邊界、`assertTenantIdentity` 及 current `admins.role/status` 檢查。部署入口**沒有** `isVerifiedLineIdClaim`，但仍有 tenant 與 admin 查詢；不可直接判定所有請求可越權 | 版本差異需在核可沙盒驗證並安排受控部署；當前真實 LINE、跨商家 A/B、撤權後舊憑證結果未驗 |
| `member-profile-api` | v33 | **是**（兩端各 19,106 字元） | `verifyLineIdTokenContract`；member 端 4 個 action allowlist、`CLIENT_ACTION_MISMATCH`、按驗證後的 LINE 身分查詢會員、`MEMBERSHIP_REQUIRED` | 共用依賴、資料庫實際授權、會員 A/B 與停權舊 token 真實負向仍待測 |
| `booking-admin-operations` | v27 | **是**（兩端各 33,236 字元） | `admin.booking.*` 入口限制、`verifyLineIdTokenContract`、`authorizeAdmin`；部分變更 RPC 傳遞驗證身分衍生的 `p_actor` | 全 action 的資源 owner、跨商家 A/B、共用依賴及實際 SQL 結果仍待測 |
| `point-ticket-batch-api` | v8 | **是**（兩端各 1,243 字元） | 已退休相容入口：`OPTIONS` 204，其餘回應 HTTP 410／`FUNCTION_RETIRED`，指向 `pointcard-extension-api` | 實際遠端 HTTP 410 與租戶 wrapper 故障路徑仍待測 |

## 共用安全依賴的部署差異（同輪追加）

入口檔相同**不等於**整個部署套件相同。繼續檢查上述三支 ACTIVE 業務 Function 打包的 `_shared` 關鍵模組，對應相同整合 SHA 的 GitHub 來源進行逐字比對：

| 已部署 Function | `auth-contract.ts` | `business-runtime.ts` | `business-scope.ts` | `tenant-access.mjs` |
| --- | --- | --- | --- | --- |
| `fixed-ticket-automation` v11 | 未打包／入口使用自行實作的 verifyAdmin | **不同**（來源 13,460／部署 11,659 字元） | **不同**（2,380／2,290） | 相同（1,137） |
| `member-profile-api` v33 | **不同**（來源 7,731／部署 7,906 字元） | **不同**（13,460／11,659） | **不同**（2,380／2,290） | 相同（1,137） |
| `booking-admin-operations` v27 | **不同**（7,731／7,906） | 相同（13,460） | 相同（2,380） | 相同（1,137） |

- 整合來源 `_shared/auth-contract.ts` 引入 `isVerifiedLineIdClaim`；會員與預約管理兩個遠端打包版本**尚無該共用 guard 的 import**。部署版仍有自己對 sub／aud／iss／exp／iat 的檢查，這是**版本與驗證契約不一致**，不能直接推斷能繞過 LINE 認證。
- 本輪三支遠端打包檔均沒有 `_shared/line-id-claims.mjs`。與來源匯入關係一致的完整 bundle 是否已部署，仍待在核可沙盒重新打包／部署與負向 HTTP 驗證。
- 此表只覆蓋四個共用檔和三支 Function，**未核對其他相依模組／整個 32 支入口，也沒有驗證遠端可見的權限資料**。任何發布決策須採完整 dependency closure、版本與執行結果，而不是只比入口。

**重要：** 上述長度和完全一致結果只針對四支入口檔；不是 32 個 Edge Function 的整體版本驗證。部署 metadata `verify_jwt=false` 不單獨等於漏洞，因為本系統也使用應用層 LINE 驗證，必須按每個 action 觀察伺服器拒絕行為。

## 驗收對照與可執行測試

| AC／Given-When-Then | 檢查與執行入口 | 本輪結果 |
| --- | --- | --- |
| AC-SEC-001：Given 固定整合 SHA 與遠端部署，When 對照 4 個入口檔，Then 記錄每個版本及是否一致 | GitHub `fetch_file` + Supabase `get_edge_function` 完整入口比對 | **唯讀 4/4 完成**；1 不同／3 相同 |
| AC-SEC-002：Given 不合法 token／錯誤 LINE claims，When 呼叫固定票券保護 action，Then 回 401 且不得查詢或變更租戶資料 | `node --test MemberWebsocket-dev/tests/fixed_ticket_admin_auth.test.js MemberWebsocket-dev/tests/edge_line_claims.test.js MemberWebsocket-dev/tests/edge_auth_contract.test.js`；後續沙盒 HTTP | **本輪未執行**。既有 CI 紀錄不代表此刻的真實遠端驗證 |
| AC-SEC-003：Given member/admin A 與 B 不同租戶，When 修改 `business`、`member_id`、booking ID 或 RPC 參數，Then 後端拒絕且資料不變 | 合成 A/B 資料、隔離 Postgres/HTTP、交易後 SQL 差異 | **受阻：需要核可隔離沙盒**；不能對正式會員資料做破壞性測試 |
| AC-SEC-004：Given 停權／降權／撤權後的舊 token，When 重試各 protected action，Then 依契約拒絕並留不含秘密的稽核 | 可控時鐘、真實沙盒 session、SQL/HTTP 負向案例 | **受阻：尚未取得該輪沙盒證據** |
| AC-SEC-005：Given 待發布候選，When 前後端來源／版本或必要 CI 不一致，Then 不可標為發布完成 | 完整 `.github/workflows/test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`、後端打包對帳與 Preview smoke | **部分：已證實一處部署差異，無放行**；此文件變更提交後需核對新 SHA 的 CI |

## 阻擋與安全執行順序

1. **P0（先阻擋發布，不直接改正式後端）**：將 `fixed-ticket-automation` 來源與已部署 v11 的差異列入 #34/#33 的 release gate。先用 #48 核可測試資源及合成管理員 A/B、會員 A/B 比對來源函式打包依賴、環境契約與真實拒絕結果。
2. 在隔離沙盒驗證來源 guard、撤權／跨商家、失敗重試與舊資料相容後，依既有發布規則評估受控的 Supabase Edge Function 部署；不得用 Netlify 靜態 Preview 取代後端驗證。
3. 每次部署記錄 function version、來源 SHA、必要完整 CI、部署時間、HTTP 與 SQL 負向案例、結果及可執行回復方案，才更新 #34 的驗收／Status。不得把 ACTIVE 或 RLS INFO 訊息直接當作漏洞結論。
4. 本次只新增稽核文件，不變更任何正式資料、schema、帳號、部署、金鑰或應用程式邏輯。回復方式為 revert 此文件提交；業務資料不需復原。

## 本次交付界線

- **已執行：** GitHub 指定 SHA 來源檔、Supabase 部署入口檔及 Netlify 部署 metadata 的唯讀查核。
- **未執行：** 新版本 Node／Deno／PostgreSQL／Chromium 測試、真實 LINE Provider、跨租戶沙盒、正式部署、前端線上冒煙。文件與 PR 的 CI 必須另外取得同 SHA 的實際紀錄才能宣稱測試通過。
- 此文件提供 SEC-03 的精確差異與後續可重現的驗收方式，**不關閉** #34／#47，亦不勾選其尚未執行的 AC。
