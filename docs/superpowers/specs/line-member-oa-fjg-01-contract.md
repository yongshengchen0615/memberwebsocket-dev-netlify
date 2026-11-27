# FJG-01｜LINE 會員端 OA／LIFF／登入 Channel 身分及好友資格驗證契約

> 關聯：#154 / #155（本文件的主 Issue）/ #156 / #157 / #158 / #144 / #59。基線：`Integrated-Marketing-Platform` @ `3b6c9b9600b20af8a929de61bc5948b3ad416c74`（2026-10-27）。本文件是盤點與後端介面設計，**不是**「必須先加入官方帳號才可註冊」的已上線證明。

## 1. 目標、範圍與安全不變條件

**目標：** 對每個商家 A/B，只有登入該商家 *會員端* LINE Login/LIFF、且經伺服器取得該 Login Channel 所連結 *會員端* Official Account 之好友狀態為 true 的新用戶，才可由「未啟用」轉為「啟用會員」。

- **AC-001：** Given A、B 各設定不同會員端 OA，When 在 A 入口註冊，Then 只使用從伺服器解析的 A 商家會員端 Channel/LIFF/OA；B 或 admin OA 均不得通過。
- **AC-002：** Given 未連結 OA、scope 缺少 `profile`、Channel/LIFF 不符、網路／Provider 設定失敗，When 進入註冊／送出資料，Then 不啟用帳號，並回報可辨識、可重試或可請店家處理的錯誤。
- **AC-003：** Given LINE User ID 屬於不同 Provider，When 切換商家，Then 不以 User ID 文字相同／不同推導跨 Provider 身分或資源權限。
- **AC-004（FJG-02 前置防繞過）：** Given 前端送出 `friendFlag=true`、自行改 `business` 或直接打 API，When 伺服器尚未完成可信身分／商家／好友狀態核驗，Then 不建立有效會員，也不發票券、不授權會員資源。
- **AC-005：** Given 既有商家停權、feature 未核准或 tenant Data Plane 未 ready，When 會員端取得公開配置或啟用，Then fail closed，不回退舊共用會員資料。
- **AC-006（相容性）：** Given 已存在的有效舊會員，When 後續取消好友或 LINE 查詢暫時失敗，Then 本次「新會員門檻」不自行刪除或停權舊會員；如需改此政策另開需求。

### 已知事實（已讀程式）

| 節點 | 現有實作／檔案 | 風險或待補 |
|---|---|---|
| 商家入口 | `MemberWebsocket-dev/business-context.js` 接收 `business`／`liff.state` 並經 `platform.business.public` 讀取功能配置、商家 LIFF；攔截 fetch 附上 slug | 前端選定的 slug **不是**後端權威身份；不得直接相信 |
| 公開商家設定 | `supabase/functions/_shared/platform-handler.mjs` 的 `platform.business.public` 使用伺服器 RPC 查詢商家，檢查 Feature、到期與 dataPlaneVerified | 這僅證明公開配置可用；**不證明 Console 已連結 OA 或好友狀態** |
| 身分初始化 | `member-system.js` 按 surface 使用 `memberLiffId` 呼叫 `liff.init`、取得 ID token；`member/app.js` 以 `user.member.bootstrap` 取得狀態與註冊表單 | ID token 用於身份，不能替代 LINE Login **access token** 呼叫好友關係 API |
| 既有後端 | `supabase/functions/api/index.ts` 分流 `user.member.bootstrap`、`user.member.profile.save`；`_shared/auth-contract.ts` 使用 LINE token verify 與授權規則 | 需逐條確認會員建立／啟用時機：只在 profile.save 擋不一定足夠 |
| 通道資料 | `_shared/platform-policy.mjs` 的 `line_config` 包含 `memberChannelId`、`memberLiffId`、`adminChannelId`、`messagingChannelId`；驗證 LIFF 前綴；`_shared/business-scope.ts` 按租戶切換 server env | Channel ID 格式／前綴驗證**不是**同 Provider、linked OA、scope 的官方證明 |
| 舊單店保護 | `member-system.js` 對 `?tenant=` 保留 `TENANT_NOT_READY` fail-closed；另有 `?business=` 路由 | 不能將前端補齊視為租戶資料平面已安全隔離；需以真後端/RLS實測 |
| OA 接收器 | #144 的 admin/member audience 路由與 webhook binding | webhook 的 follow/unfollow 可維護狀態，但不能單獨成為首次註冊可信判定 |

**尚待查證：** 各商家 LINE Developers Console 的 Provider 歸屬、member OA Linked LINE Official Account、實際 `profile` scope、LIFF Size=Full、正式與 Preview Endpoint URL、商家租戶資料平面有無完成部署、真人 LINE SDK 回應。GitHub 設定欄位無法證明 Console 端的連結狀態。本輪未讀取或列印任何 secret/個資。

## 2. 後端權威與最小實作方案

| 方案 | 內容 | 驗證性／風險／成本 | 判斷 |
|---|---|---|---|
| A（優先） | 沿用既有商家 Context、`businessHandler`／會員建立 RPC；新增「伺服器好友資格核驗」守衛在**首次有效會員啟用之前** | 範圍局部、最可回復，保留現有通知／會員資料與租戶隔離 | **選擇**，但需先找齊所有啟用入口 |
| B | 新建全域會員註冊微服務／平行帳號、通道設定、身份與表格 | 額外寫入路徑與一致性風險，對現有系統無必要 | 不採用 |

伺服器的建議核驗順序（下一個 FJG-02 PR 才實作）：

1. **確定可信 tenant：** 以後端授權的商家資源上下文與已核准 `membership` feature，讀該店 `memberChannelId` 及已設定 member OA；未開通/停權/不相符立即拒絕。來自 URL／body 的 slug 僅為查詢候選，並不是授權證據。
2. **驗身份：** 延用既有 LINE ID token 後端 `verify`、`aud`＝該 member Login Channel、有效期限及 session 規則，取得該 Provider 下的 `sub`；不要跨 Provider 共用 User ID，也不要將 admin Channel 的登入當會員身份。
3. **驗好友：** 由 LIFF 用戶端在適當流程取得短期 LINE Login **access token**，只以 TLS 傳給後端，不寫入持久資料、URL、日誌、audit；後端先驗其有效性、所屬 channel 與 `userId` 和 Step 2 的 subject 一致，再以該 token 呼叫 `GET https://api.line.me/friendship/v1/status`，要求 `profile` scope、已 linked **該 Login Channel** 的 member OA 且 `friendFlag === true`。
4. **只於可信 gate 後啟用：** 不能接受 body 的 `friendFlag` 或 callback 的 `friendship_status_changed` 做啟用證據。LINE 401／403／429／5xx／timeout／格式錯誤都 fail closed，但須區分「未加好友」與「服務暫不可用」，避免錯誤引導。
5. **交易／冪等：** 用既有 unique、RPC/DB transaction 保障首次啟用至多一次，與 #151/#152 邀請歸因／票券發放隔離。避免 bootstrap 或其他 profile 更新途徑在驗證前啟用，避免對已存在合格會員無端重複查詢或反覆發獎。
6. **失效／撤權：** 對新的註冊驗證做 bounded timeout、速率限制。是否要求老會員重新加好友、多久刷新需另有明確產品規則；預設不更改存量會員狀態。

**必要前置阻擋：** 若無法在 LINE Console 核對商家 Login Channel ↔ 會員端 OA 同 Provider 且 Linked，或未能取得可信 access token 並綁定身份，FJG-02 不得採用「前端布林值」或「Webhook 最後一次狀態」替代後端資格檢查。沒有配置完整時，以明確不可註冊為安全預設。

## 3. 身分、權限、狀態與最少資料

| 角色 | 看得見／可執行 | 伺服器必須拒絕 |
|---|---|---|
| 訪客／未驗證用戶 | 公開商家入口、登入、加入 OA 引導 | 會員資料／票券、直接啟用、偽造好友旗標 |
| 會員 A | 已授權商家 A 的自有會員資料，照既有功能使用 | 跨會員、跨商家、管理端資源、自行升權 |
| 商家 A 管理員 | 依 #59/#144 的管理功能設定 A 店獲准的 LINE 通道 | 修改 B 店、查看 access token 明文、代替用戶通過好友核驗 |
| 總管理員 | 已核准範圍內的商家開通與設定治理 | 以前端繞過會員登入、把未知 Provider 的 LINE User ID 當同一主體 |

新用戶最低狀態：`unverified`（登入但好友資格尚未通過）→ `eligible`（同次伺服器驗證為好友）→ 依現有條款及完整資料 `active`。此為**邏輯狀態模型**，**不表示需要新增 DB 欄位**。好友不符、scope/Channel/tenant 缺失時維持未啟用。只保存現有會員/商家資料及必要稽核結果；不得新增可重放 token 紀錄。

## 4. 測試計畫（未執行 = 尚未通過）

| AC | 測試層級／重點 | 預期證據 |
|---|---|---|
| AC-001 | Node 商家配置 A/B fixture + Edge API direct call + PostgreSQL 17/RLS | A 店通道只核對 A OA，admin/B 錯配全拒絕，資料結果無跨店 |
| AC-002 | Node/Edge：未 linked、profile 缺失、LINE 401/403/429/5xx/timeout、token 失效 | error code 區分不可用／未加好友；不得新增 active row |
| AC-003 | 不同 Provider token user ID 碰撞／不一致 + 租戶 RLS | 零跨店授權／資料合併 |
| AC-004 | 直接 POST 注入 friendFlag/business、重放、併發 2/10 次與首次啟用 | 後端獨立核對；最多一次啟用及零重複票券 |
| AC-005 | 已撤權、停權、功能未開通、非法 LIFF／Channel，含舊 token | 401/403/409/503 適當拒絕；不回退 legacy data |
| AC-006 | 舊會員已有資格後取消 OA 好友／LINE 暫不可用 | 原會員、預約、票券資料與權限維持既有合約 |
| ALL | `node --test MemberWebsocket-dev/tests/*.test.js`、Edge Deno tests、PG migration／併發、完整 GitHub Actions `Validate MemberWebsocket Dev`、Chromium 390/1280、原生 Netlify Preview + 真人 LINE 沙盒 | 每項綁最終 SHA、run ID、pass/fail/skip、時間、exit code、部署身分與回復證據 |

**測試資料：** 隔離 A/B 商家、合成會員 A/B、admin、待驗證、停權者，LINE 真服務只用核可的測試帳號/商家 OA。已存在 CI 不可因「這一批只加守衛」而減少。第三方 stub 通過不能冒充實際 LINE Console/登入測試。

## 5. 本輪變更、未完成項與回復

- 本輪只新增本文；無執行程式、API、DDL、Edge、Netlify 或 secret 變更。無產品執行期效能影響，因此不宣稱 p95/資產 bytes 改善。
- **需續做：** 完成既有 `api` 的會員啟用入口追蹤、LINE channel metadata/linked OA 稽核、商家實際隔離測試；在 #156 先 RED 再 GREEN；#157 做前端加好友／解封引導；#158 將 webhook 狀態作輔助而不是信任來源。
- **回復：** 刪除此文件的獨立 PR/revert commit；不需要資料庫／Edge／Netlify 回復。看板狀態在完整驗收前不移至已完成。

## 官方依據

- [LINE Login – Linked LINE Official Account／同 Provider 限制](https://developers.line.biz/en/docs/line-login/web/link-a-bot)
- [LINE Login – Get friendship status，需 profile scope](https://developers.line.biz/en/reference/line-login/#get-friendship-status)
- [LINE Login – 不同 Provider 使用者 ID 不等同](https://developers.line.biz/en/docs/line-login/getting-started/)
