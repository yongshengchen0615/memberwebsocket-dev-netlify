# 正式電話驗證切換 Bird

## 範圍與決策

基線 master f2c0ef2f8c7d14a144c54405eaca04323cf0e819。目標是正式會員首次入會／更換電話改用 Bird；正式資料、LINE 身分與商家歸屬、電話唯一限制、交易、限流保持不變。採既有測試分支 Bird 實作的最小移植；不重建認證架構，不新增依賴或 migration，不修改測試環境 Secrets。程式先部署、憑證就緒後切換，最後刪除 Twilio 設定。

## 驗收與測試

| AC | Given / When / Then | 證據 |
|---|---|---|
| AC-001 | Given 正式 Bird 設定，When 發送／檢查，Then 僅呼叫 key 區域的官方 Bird HTTPS API，僅 success=true 後啟用／綁定 | twilio_verify_member_join.test.js 的 Bird 案例；真人 SMS 另驗 |
| AC-002 | Given 正式切換已驗證，When 列出正式 Supabase／GitHub／Netlify 變數，Then 不存在 TWILIO_*，且保留 PHONE_VERIFY_REQUIRED 原必驗規則 | 各服務寫後讀回名稱；不可在移除前宣稱通過 |
| AC-003 | Given 兩個隔離環境，When 建置與部署，Then master 仍對應 dbuquirnaskrwcamdxki、測試仍對應 bmwhojszsnxliekkhrka | scripts/branch-environment.test.mjs；公開 config 讀回 |
| AC-004 | Given 新程式，When 錯碼／到期／重複電話／限流／供應商故障／舊 API 繞過，Then 拒絕且不錯綁／不重送 | OTP 43 案例（含全無 TWILIO_* 的正式設定）及全專案三條 CI |

命令：node --test MemberWebsocket-dev/tests/twilio_verify_member_join.test.js；node --test MemberWebsocket-dev/tests/*.test.js；既有 Test MemberWebsocket Dev、Test Netlify build、MemberWebsocket Ticket Policy UI Tests 必須於最終 SHA 執行完整基線。

已實際 RED：42 案例，15 pass／27 fail／0 skip，舊正式程式缺少 Bird 與 provider-neutral gate。移植後 GREEN：原 42 案例全通過；另新增正式環境所有 TWILIO_* 皆不存在的驗證，最終共 43 案例。實際服務與完整 CI 以後續 run 為準。

## 品質、效能與回復

沿用既有 adapter，只有一個 Bird HTTP 呼叫，不重試付費發送或一次性 check；API 金鑰／OTP／供應商錯誤內容不傳給用戶。前端無修改，資產大小與原流程無新增請求。沒有實際服務延遲量測，不宣稱提速；以 request count 斷言與來源 bytes 作靜態比較：member-system.js 49,878 → 49,878 bytes；member-profile-api 31,284 → 33,521 bytes；api 168,728 → 168,785 bytes。

回復點為上述 master SHA；先恢復已驗證的供應商配置與原必驗旗標，再 revert 程式。保留會員電話驗證紀錄，不執行正式資料破壞測試。Supabase 管理頁登入、正式專用 Bird key、真實門號／LINE 驗收若缺少，列為受阻，不能以 stub 代替。
