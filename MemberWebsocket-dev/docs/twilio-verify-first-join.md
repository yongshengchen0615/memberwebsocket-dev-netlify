# 會員卡初次加入會員：Twilio Verify SMS OTP

## 驗收與安全界線

- 新會員於「加入會員」輸入手機時，可點「發送簡訊驗證碼」；手機欄位下方輸入 OTP，確認入會時由伺服器呼叫 Twilio Verification Check。**僅 status=approved 才啟用會員**。
- 將手機正規化成 E.164；目前預設只有台灣 +886 手機號碼可發送（其他國碼需有意識開通）。
- OTP 不存在前端長期儲存、Supabase 資料表、LINE 訊息或伺服器 log；由 Twilio 管理效期及重送機制。
- LINE ID token 的原有驗證及會員資料歸屬流程保持不變。只有既有 `members.membership_status != 'active'` 的首次入會被要求驗證。已完成入會者保持現有行為。
- 更換輸入電話後清空已填驗證碼。伺服器針對 **當次提交電話** 驗證，不依賴前端聲稱「已驗證」。
- 會員條款版本及同意確認仍由伺服器檢查。
- 新舊 API 同時受保護：`member-profile-api` 可檢查 Twilio；舊 `api` 入會操作在啟用旗標後拒絕未入會用戶，避免被直接呼叫繞過。
- 不自動合併同電話不同會員。現階段不新增 `phone_verified_at` 欄位；因此無法回溯區分歷史電話資料是否經過簡訊驗證。

## 原有架構

`member/index.html` + `member/app.js` → `member-system.js` → Supabase Edge Function `member-profile-api` → `accept_membership_terms_api` → `members`。沒有改寫現有資料表、權限或入會 SQL 交易。

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
3. 將更新後的 `member-profile-api` **與**舊 `api` 一起部署至對應 Supabase 專案，先維持 `TWILIO_VERIFY_REQUIRED=false`；確認舊流程可運作。
4. 部署前端，確認按原有會員登入正常；新會員尚不會收到簡訊。
5. 在隔離環境改成 `TWILIO_VERIFY_REQUIRED=true`，以實際測試門號驗證發送、批准、錯誤、期限、次數限制及入會結果。
6. 做正式啟用決策後，再於正式環境最後切換旗標為 `true` 並監看 Twilio 計費與錯誤率。**沒有憑證與真實門號測試，不可宣稱可上線。**

## 回復與停用

發生發送障礙或大量新會員無法加入時，第一步將伺服器 `TWILIO_VERIFY_REQUIRED` 設回 `false`：舊入會流程立即恢復，不需資料庫 rollback。再以 Git revert 回復功能分支所帶來的前後端變更。

## 測試

```bash
node --test MemberWebsocket-dev/tests/twilio_verify_member_join.test.js
node --test MemberWebsocket-dev/tests/*.test.js
node --test MemberWebsocket-dev/tests/integration/member_terms_startup.cjs
(cd MemberWebsocket-dev/tests/browser && npm test -- --grep "member phone OTP")
```

以上瀏覽器案例使用專案既有 Playwright 設定執行；完整流程由 GitHub CI 測試；瀏覽器 fixture 與 Twilio stub 通過不代表 Twilio 真正能對台灣手機發送。

## 整合分支說明

本版本以 `Integrated-Marketing-Platform` 為基準移植，不合併舊 `main` 功能分支。遵守該分支既有測試會員 API 固定 410 退役契約，保留 LINE 好友引導、會員邀請及相關權限，且 `TWILIO_VERIFY_REQUIRED` 維持關閉直到真人／沙盒驗收。GitHub Actions 的成功不等同於真實簡訊送達或正式部署。
