# 會員卡加入會員與修改電話：Twilio Verify SMS OTP

## 驗收與安全界線

- 新會員於「加入會員」輸入手機時，可點「發送簡訊驗證碼」；手機欄位下方輸入 OTP，確認入會時由伺服器呼叫 Twilio Verification Check。**僅 status=approved 才啟用會員**。
- 將手機正規化成 E.164；目前預設只有台灣 +886 手機號碼可發送（其他國碼需有意識開通）。
- OTP 不存在前端長期儲存、Supabase 資料表、LINE 訊息或伺服器 log；由 Twilio 管理效期及重送機制。
- LINE ID token 的原有驗證及會員資料歸屬流程保持不變。首次入會和**已入會會員更換電話**，在 `TWILIO_VERIFY_REQUIRED=true` 時都要求驗證新號碼；未修改的號碼無須再次驗證。
- 更換輸入電話後清空已填驗證碼。伺服器針對 **當次提交電話** 驗證，不依賴前端聲稱「已驗證」。
- 會員條款版本及同意確認仍由伺服器檢查。
- 新舊 API 同時受保護：`member-profile-api` 可檢查 Twilio；舊 `api` 入會操作在啟用旗標後拒絕未入會用戶，避免被直接呼叫繞過。
- 不自動合併同電話不同會員。新增 `phone_verified_e164` 與 `phone_verified_at`；僅在 Twilio 回傳 approved 後透過資料庫交易綁定，使用同一商家的唯一索引阻止重複綁定。歷史電話不自動視為已驗證。
- 會員更換電話、舊 API 直接修改或管理員改號時，資料庫 Trigger 會移除舊號的已驗證標記。新號碼驗證失敗時保留原手機。
- 各商家使用獨立 schema 的資料與索引，同號限制以**各商家**為界。

## 原有架構

`member/index.html` + `member/app.js`／`member/profile-extension.js` → `member-system.js` → Supabase Edge Function `member-profile-api` → `member_commit_verified_phone`（同交易內呼叫入會 `accept_membership_terms_api` 或進行改號）→ `members`。舊版 `api` 必須封鎖未驗證入會及改號繞道。

## Twilio／Supabase 配置

在 Twilio Console 建立 **Verify Service**，檢查 **Verify Geo Permissions** 僅開放業務需要的國家與地區，並建立權限最小的 API Key。試用帳戶通常需先驗證目的號碼，才可發送測試簡訊。

僅於 Supabase Edge Functions 的秘密設定中存放：

| 環境變數 | 內容 |
|---|---|
| `TWILIO_VERIFY_SERVICE_SID` | `VA...` Verify Service SID |
| `TWILIO_API_KEY_SID` | `SK...` Twilio API Key SID |
| `TWILIO_API_KEY_SECRET` | Twilio API Key Secret（不得輸出或提交） |
| `TWILIO_VERIFY_ALLOWED_COUNTRY_CODES` | 預設 `+886`；多國時以逗號分隔 |
| `TWILIO_VERIFY_REQUIRED` | **最後才設定為 `true`**；預設不啟用 |

注意：所有鍵都必須是 Edge Functions *server-side* secrets，絕不能放進 `MemberWebsocket-dev/config.json`、Netlify 公開設定、GitHub 或前端 JS。

## 建議安全發佈順序

1. 在非正式環境配置 Twilio 測試設定，僅使用核准的測試手機，不使用正式會員資料做破壞性測試。
2. 確保變更版本的完整 GitHub Actions（回歸、DOM、Chromium、PostgreSQL、Edge 型別檢查、建置與套件安全）通過。不能把未執行或外部環境造成的失敗算通過。
3. 在**隔離資料庫**先以 PostgreSQL 17 測試 migration `20261104160600_member_verified_phone_binding.sql`（既有／新建商家、併發唯一性、Trigger、交易回復），確認通過後備份正式資料庫並安排遷移。此步尚未對正式環境執行。
4. 將更新後的 `member-profile-api` **與**舊 `api` 一起部署至對應 Supabase 專案，先維持 `TWILIO_VERIFY_REQUIRED=false`；確認舊流程可運作。
5. 部署前端，確認按原有會員登入正常；新會員尚不會收到簡訊。
6. 在隔離環境改成 `TWILIO_VERIFY_REQUIRED=true`，以實際測試門號驗證發送、批准、錯誤、期限、次數限制及入會結果。
7. 做正式啟用決策後，再於正式環境最後切換旗標為 `true` 並監看 Twilio 計費與錯誤率。**沒有憑證與真實門號測試，不可宣稱可上線。**

## 回復與停用

發生發送障礙或大量新會員無法加入時，第一步將伺服器 `TWILIO_VERIFY_REQUIRED` 設回 `false`：舊流程會恢復，但停用期間不能保證手機所有權驗證。**不得直接 rollback 掉已儲存的驗證紀錄欄位**；保留資料，之後以向前遷移修復。前端及 Edge 可用 Git revert 回復，停用旗標期間換號會由 Trigger 清除驗證紀錄。

## 測試

```bash
node --test MemberWebsocket-dev/tests/twilio_verify_member_join.test.js
node --test MemberWebsocket-dev/tests/*.test.js
node --test MemberWebsocket-dev/tests/integration/member_terms_startup.cjs
# PostgreSQL 17 隔離 CI 執行：node --test MemberWebsocket-dev/tests/integration/postgres/member-verified-phone.cjs
(cd MemberWebsocket-dev/tests/browser && npm test -- --grep "member phone OTP")
```

以上瀏覽器案例使用專案既有 Playwright 設定執行；完整流程由 GitHub CI 測試；瀏覽器 fixture 與 Twilio stub 通過不代表 Twilio 真正能對台灣手機發送。

## 整合分支說明

本版本以 `Integrated-Marketing-Platform` 為基準移植，不合併舊 `main` 功能分支。遵守該分支既有測試會員 API 固定 410 退役契約，保留 LINE 好友引導、會員邀請及相關權限，且 `TWILIO_VERIFY_REQUIRED` 維持關閉直到真人／沙盒驗收。GitHub Actions 的成功不等同於真實簡訊送達或正式部署。

## 新增驗收與安全邊界

| 編號 | 驗收 |
|---|---|
| AC-001 | 首次入會 Twilio approved 後同一資料庫交易啟用會員與儲存驗證標記 |
| AC-002 | 相同會員、相同已驗證號碼不重複發簡訊，重新載入仍是已驗證 |
| AC-003 | 修改電話需要新 OTP；錯碼、取消、併發衝突均保留原電話 |
| AC-004 | 同商家不同會員不能重複綁定同一號碼，唯一索引維持最終一致性 |
| AC-005 | 已有及未來新增的商家都必須具備欄位、索引、觸發器及僅 service_role 可呼叫的 RPC |
| AC-006 | 上線前需隔離測試與真實 Twilio SMS 驗證，且所有原有 CI 通過 |

啟用順序：隔離資料庫遷移測試 → 正式資料備份與 migration → 兩支 Edge Functions 部署 → 前端部署 → 沙盒／真人測試 → 最後啟用 `TWILIO_VERIFY_REQUIRED=true`。

舊資料的電話不自動視為已驗證；不得回填 `phone_verified_at`，除非有具證據的原始核准紀錄。新資料寫入及驗證屬於會員自己的商家作用域，不會合併跨商家帳號。
 