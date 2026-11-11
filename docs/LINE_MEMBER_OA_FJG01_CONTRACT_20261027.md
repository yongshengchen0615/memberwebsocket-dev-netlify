# FJG-01｜每商家會員端 LINE OA 入會資格契約與實作計畫

> Project #5｜Issue #155，父卡 #154，後續 #156～#159。此文件是**原始碼／資料結構盤點與下一輪可執行規格**，不是已實作、已修補或已通過真人 LINE 驗收。  
> 盤點日：2026-10-27；來源分支：`Integrated-Marketing-Platform`；基線 commit：`3b6c9b9600b20af8a929de61bc5948b3ad416c74`。不得用其他 SHA 的測試結果代表此份規格已上線。

## 1. 可觀察目標與不變條件

**目標角色／行為：** 新訪客進入商家 A 的會員卡時，必須先登入 A 對應的 LINE Login／LIFF，確認已加入其 **member 官方帳號**（不是 admin OA，也不是商家 B 的 OA），才能首次啟用 A 的會員資格。若尚未加入，顯示可重試引導但後端拒絕啟用。已存在的會員、預約、點數與票券邏輯必須保持原行為，除非另有經批准的遷移規格。

**安全不變條件：** 
1. 商家 A 的好友確認，不得成為商家 B 的註冊資格；管理端 OA 不得充當會員端 OA。
2. 身分識別的信任來源是**伺服器驗證**的 LINE Login ID token／access token、有效的 tenant 與其 linked member OA 設定，不是瀏覽器提交的 `business`、`friendFlag`、`userId` 或 LIFF 回報。
3. 無法確認「正確商家＋正確 LINE Login Channel／Provider＋linked member OA＋好友狀態」時**拒絕首次啟用**；錯誤不得當成「已加好友」。
4. 只允許完成既有條款／資料條件的首次啟用。未加好友或配置錯誤時，不得觸發任何首次入會票券、推薦歸因、通知或自動化副作用。
5. 已啟用舊會員不因後續 unfollow 自動停權／刪除（沿用 #156 現行相容性假設；正式變更需另行決策）。

## 2. 已確認的原始碼與資料庫事實

| 層級 | 現況與程式位置 | 對 FJG-01 的意義 |
|---|---|---|
| 商家入口 | `MemberWebsocket-dev/business-context.js`：從 URL 取得 slug，經 `platform.business.public` 查公開設定；並在前端對 Supabase request body 加入 `business` | 前端有商家選擇，但**不能作為授權的可信 tenant 綁定** |
| LINE 設定 | `admin/business-line-settings.js`：每功能 `memberChannelId`／LIFF ID 設定、格式及字首比對；`_shared/platform-handler.mjs` 使用 `platform.line.save` 儲存 | 有分模組 Login/LIFF 設定。格式比對**不等於** LINE Console 已 linked 正確的 OA／Provider |
| 客戶端路由 | `MemberWebsocket-dev/member-system.js` 第 497–499 行：`user.member.bootstrap`、`user.member.profile.save`、`user.member.terms.accept` 走 `/functions/v1/member-profile-api` | #156 必須保護這個**真正使用中的入口**，不可只修改舊的 `api/index.ts` |
| 身分驗證 | `supabase/functions/member-profile-api/index.ts` 第 53–58 行：使用 `LINE_MEMBER_CHANNEL_ID`（含固定 fallback）驗證 ID token；第 239–261 行處理 request | 目前沒有觀察到在此入口以所選商家的 member Channel 動態驗證；尚不能宣稱每店驗證已具備 |
| 首次資料處理 | 同檔第 66–83 行 `ensureMember()` 以 `line_user_id` 查／建立 `members`；第 324–347 行依資料完整與 `accept_membership_terms_api` 轉入有效會員 | 這是首次啟用真正的權限檢查點，需在可寫入／啟用前驗證，不得只加 UI |
| 其他 API | `supabase/functions/api/index.ts` 亦含 `ensureMember`、`user.member.bootstrap`／`profile.save` 路徑 | 必須盤點直接 API、舊 client 及其他首次註冊途徑，避免繞過新門檻 |
| 資料模型 | 2026-10-27 對 `dbuquirnaskrwcamdxki` **唯讀**查 `information_schema`：`public.members` 無 `tenant_id` 欄位；`platform_private.tenants` 有 `runtime_schema`／`module_line`；有 `line_channel_owners`／`line_webhook_bindings` | 既有 public 會員識別與 tenant runtime schema 並存。不能直接假定「LINE User ID＝跨商家會員唯一鍵」或貿然新增/遷移欄位；先確定各店真正的會員資料歸屬 |
| 既有測試 | `tests/integration/business_line_settings.cjs`、`line_capabilities.cjs` 已涵蓋 LIFF 與登入 Channel 格式、模組隔離；`member_terms_startup.cjs` 覆蓋資料／條款客戶端流程 | 上述測試**不等於**已覆蓋 Provider linked OA、好友資格伺服器驗證、跨商家註冊競態 |

**風險（由上述程式與 schema 推論，尚非真實越權攻擊證據）：** 既有 `member-profile-api` 固定 Channel 驗證與 `public.members` 非 tenant 鍵不足以直接滿足「每商家會員端 OA 資格」；倘若只在 UI 加 `liff.getFriendship()`，用戶可繞過前端請求。開始改寫前須確認商家 runtime 資料路由、目前已發會員來源及現存 RPC 的寫入範圍。

## 3. 官方 LINE 條件與信任契約

官方限制：
- LINE Login Channel 要 linked OA，該 OA 的 Messaging API channel 必須與 LINE Login Channel **屬於同一 Provider**；操作者需兩端管理員權限；每個 LINE Login Channel 最多 linked **一個** OA。
- LIFF ID 所屬 Login Channel、LIFF Endpoint HTTPS、LIFF size Full、`openid`（取 ID token）與 `profile`（好友資格）scope 需逐店實際確認。這些是管理端／LINE Console 的設定查核，不可僅依字串推導「已 linked」。
- LINE Login `GET https://api.line.me/friendship/v1/status` 使用該 **Login Channel 的使用者 access token**（須含 `profile` scope）；只會回覆**該 Login Channel linked OA** 的 `friendFlag`。不能使用 ID token 或 Messaging channel access token 取代使用者 access token。
- 用於首次啟用時，後端先確認 access token 有效、`client_id` 等於可信 tenant member Login Channel、scope 包含 `profile`，並把 token 身分與已驗 ID token 的 `sub` 綁定；再查好友狀態。不同 Provider 的 `sub` 不應推論同一人。
- Token 只在 HTTPS request／後端短暫處理，**不得寫入資料庫、log、audit、URL 或回應**；失敗只回安全錯誤碼與建議操作。
- `friendFlag=true` 仍須既有條款、驗證、會員狀態、唯一性及後端權限全數通過。Webhook follow/unfollow 事件僅供狀態／引導與稽核，不可代替首次啟用當下的官方檢查。

官方參考：
- https://developers.line.biz/en/docs/line-login/link-a-bot/
- https://developers.line.biz/en/reference/line-login/#get-friendship-status
- https://developers.line.biz/en/docs/liff/registering-liff-apps/

## 4. 信任邊界與失敗回應（下一批 API 契約）

| 情境 | 可信來源／伺服器動作 | 必要結果 |
|---|---|---|
| A 店新會員，已加 A member OA | 先以可信店鋪上下文決定 Channel，驗證 token / 使用者 / linked OA 設定，再查 LINE friendship | 進入既有條款流程後才允許首次 active |
| A 店新會員，只加 B 店 OA 或 A admin OA | 只能查 A member Login linked OA，不接受客戶端聲稱 | 新會員不得 active，A/B 無交叉寫入 |
| 用戶偽造 `friendFlag=true`、替換 `business` 或 ID | 後端無視客戶端好友旗標，對 tenant 與 token 做強驗證 | 403；無會員啟用、無票券副作用 |
| member OA 未 linked／Channel、scope、LIFF 設定不符 | 設定完整性閘及 LINE Console 真實配置核對（屬外部驗收） | fail-closed；不把未配置視為好友 |
| LINE API 401／429／5xx／逾時 | 限流、期限、錯誤分類，不使用過期好友快取作放行 | 401/429/503 對應安全錯誤；可重試；不啟用 |
| 併發相同首次註冊／重放 | 既有 DB 交易與唯一鍵維持 exactly-once 啟用效果 | 最多一次有效入會與獎勵，不多建會員 |
| 已啟用舊會員或 unfollow | 保留原有授權與資料契約，另行紀錄狀態 | 本期不自動停權，不抹除舊資料 |

## 5. 方案比較與決策

| 方案 | 優點 | 風險／成本 | 判定 |
|---|---|---|---|
| A：沿用既有 per-tenant LINE 設定、`member-profile-api` 與原入會 RPC，加入可信店鋪 / Channel / 好友 Gate | 不增加平行 OA 管理、不改前端登入架構，易以原有功能測試回歸 | 必須先釐清現存 global `members` 與 per-tenant runtime schema 的真實歸屬，避免跨店混帳 | **優先候選；待 schema/dataflow 查核後實作** |
| B：新增第二套 OA 設定與全新獨立會員 API/資料表 | 可隔離新功能 | 設定重複、歷史會員遷移與跨端相容成本高、增加錯誤來源 | **不採用**，除非證明既有模型無法達標 |

此輪**沒有核准**把所有 `public.members` 轉為新 schema、強制重新註冊，或跨 Provider 合併 LINE 身分。上述選擇只界定最小安全改動方向，不代表實作通過。

## 6. 可執行工作分解與 AC → 測試 → 證據

先 #155 鎖定資料歸屬與 LINE 配置契約，再由 #156 實作後端 Gate；#157 UI 與 #158 Webhook 依已定契約接入，最後 #159 全鏈路。

| 驗收編號 | Given / When / Then | 測試與必要實際證據 |
|---|---|---|
| AC-001 | Given A/B 不同 member OA；When 由 A 註冊；Then 僅使用 A 的可信 Login/LIFF/linked OA，不能接受 B 或 admin OA | 新增模組設定契約單元測試 + 兩店 Edge direct-call + LINE Console A/B 配置紀錄 |
| AC-002 | Given Login/OA 未 linked、`profile` scope 缺失或 LIFF 配置錯誤；When 新註冊；Then 後端安全拒絕、前端可修正／重試、未啟用 | 合成 LINE 401/403、配置不符、timeout 測試 + 真 LIFF Sandbox |
| AC-003 | Given Provider、user、tenant 或 token audience 不符；When 改 URL／body／直接呼叫 API；Then 無跨店資料寫入且拒絕 | Edge 403 負向 + PostgreSQL 合成 A/B 交易查核 |
| AC-004 | Given 未加好友／已加好友；When 有效提交會員資料／條款；Then 未加者不能 active，已加者恰好首次 active | `member-profile-api` 單元、API 整合與實際資料庫結果 |
| AC-005 | Given LINE 429/5xx／過期 token／並發註冊；When 呼叫；Then 安全拒絕或 exactly-once，不重複發券 | 可控制時鐘 + stub 故障 + 真 PostgreSQL 多連線終態 + 既有推薦獎勵回歸 |
| AC-006 | Given 舊會員、預約、點數與票券；When 部署新 Gate；Then 不改寫既有啟用、預約／票券守恆與跨角色權限 | 既有 regression、integration、PostgreSQL、Chromium + QA 真人走查 |

**下一輪 RED→GREEN 實作順序（不在本文件 PR 實施 runtime 變更）：**
1. 查現有 `serveBusiness`、`ensureMember`、`accept_membership_terms_api`、tenant `runtime_schema` 路由以及註冊的其他入口，定義每筆會員的權威 tenant 鍵與存取規則；加可重現的 A/B 隔離 RED。
2. 以已有 backend LINE 設定與 token 驗證元件新增最小可測的好友資格驗證 Gate，測無設定、錯誤 Provider、access token scope、身份與 A/B 身分綁定；RED→GREEN。
3. 在**第一次 active 的既有 DB 寫入/交易路徑**強制 Gate；封鎖直接呼叫與其他入口繞過，確保同一個身份同時註冊下不重複啟用／發券。
4. 串接 `member/app.js` 未加入好友引導、加入後重新查驗；避免不必要的重複 LINE 呼叫與無限重試。
5. 完成 `#159` 真實 Preview/LIFF/OA 沙盒驗證。未有真人授權及兩店 linked OA 配置前，不能宣稱完成。

## 7. 測試執行、環境、阻礙與回復

**此文件 PR 的變更界線：** 只新增 Markdown 盤點／契約，**不修改** JS、API、SQL、RLS、Secrets、Netlify、LINE 設定，不觸發外部訊息或資料寫入。Runtime 效能前後比較不適用，亦不得宣稱 API p95 改善。

**開發驗收基線（下一輪實作時執行）：**
- 單元/整合：`node --test MemberWebsocket-dev/tests/integration/line_capabilities.cjs MemberWebsocket-dev/tests/integration/business_line_settings.cjs MemberWebsocket-dev/tests/integration/member_terms_startup.cjs`，再補新 AC 測試。
- 全套回歸／安全／建置：執行 repo 已有 `.github/workflows/test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml` 的**所有必需 job**；核對每個 job、最終 SHA、exit、pass/fail/skip、報告 URL。
- 資料庫：隔離 PostgreSQL 17 的新建、既有結構升級、A/B 多連線與交易結果；不得以 live Supabase 跑資料清除或 destructive 測試。
- 瀏覽器：Preview 實機／Chromium 的加入／未加入／取消／重整流程；真 LINE Provider 配置另以核可的測試 OA、測試帳號驗證，stub 不等於真 LINE。
- 若任何必需案例 skipped／受阻／逾時、尚未取得同 SHA 測試證據，PR 維持 Draft，Issue 不得標完成。

**已知阻礙：** 本輪 Project #5 fields/items API 回應 `403 Resource not accessible by integration`，不能直接改 Status 或聲稱寫後讀回；外部 A/B 店 LINE Login Provider 與 member OA 的真實 linked 配置仍需核對；網路隔離的執行容器無法 `git clone` GitHub，不能把程式審閱當成完整本機 E2E。

**回復：** 如本文件不符合契約，直接關閉 Draft PR 並刪除隔離分支即可；不影響已存在的會員／資料／部署。未來若有程式實作，採獨立功能 PR、可回復 commit 與已驗證 migration/backup 計畫。
