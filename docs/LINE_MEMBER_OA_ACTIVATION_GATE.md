# FJG-02｜新會員加入所屬 LINE 官方帳號後才可啟用（堆疊 Draft PR）

## 版本、角色與安全決策

- 上游：#155 / Draft PR #164（共用 LINE access-token 驗證器）。
- 本 PR：#156，目標 `Integrated-Marketing-Platform`，程式分支以 #164 HEAD 為父，最終不直接修改 Production。
- 角色：A/B 商家各有獨立 member OA、各自 Login Channel/LIFF。訪客與新會員不可自行宣告好友狀態；已啟用會員不因日後封鎖 OA 而被停權或刪除。
- 驗證器依賴既有 ID Token server verification (issuer/aud/sub/expiry/session/revocation)，再檢查臨時 Access Token 的 `client_id`、`profile`、有效期限及 User ID，最後以官方 friendship status 的 `friendFlag === true` 准許第一次註冊。Webhook 事件、前端好友布林值及 `business` 參數都不能授權。
- 既有 RPC `accept_membership_terms` 及 `accept_membership_terms_api` 以 `SELECT ... FOR UPDATE` 鎖定會員，再於交易中寫入 consent + `membership_status=active`。兩函式在已檢視的測試專案中均不允許 anon/authenticated EXECUTE；本 PR 不重寫或直接調用其他啟用 RPC。
- 本輪沒有 DB migration、Supabase 函式部署、正式 LINE Token/Console 變更或真人註冊。**不能把加入好友視為成功註冊；還須同意條款、完成資料、DB 原子轉移。**

## 伺服器可信綁定設定（不放 Git）

新增加強門檻 `MEMBER_OA_VERIFIED_LINKS_JSON`，僅設定在受權限保護的 Supabase Edge Function Secrets：

```json
[
  {
    "tenantId": "00000000-0000-0000-0000-000000000001",
    "memberLoginChannelId": "1234567890",
    "memberOaId": "@merchant_member_a"
  }
]
```

以上**純合成範例，不可直接複製至真實環境**；由核准維運人員先在 LINE Developers 驗證該店會員端 OA 確實 Linked 到指定 LINE Login Channel、同 Provider、LIFF `profile` scope、會員入口 Full／正確路徑，並查證 tenant / member OA 一致，才可新增記錄。這是需要外部驗證的**人工審核信任清單**，不是宣稱系統自動查出了 Linked OA ID。

服務端只從受驗證的 `businessContext()` 查找 `tenant.id`、會員功能權限、會員 Login Channel/LIFF，並要求清單中恰好一筆同 tenant、同 member Login Channel 的可信紀錄。未設定、錯設定、重複匹配或 A/B 使用相同 Login Channel 時，預設 503，**不會自動改走 admin OA 或全域 Login Channel**。已啟用會員保留原有編輯/條款同意流程，不需二次好友驗證。

Access Token 只於 `user.member.profile.save` 首次條款同意送至後端，在記憶體中用於 LINE API；不寫 DB/日誌/HTTP response。實際 API verify 官方要求 token 作 GET query，應在 Edge 網路/APM 追蹤紀錄遮蔽完整 URL/query，並禁止抓取 Request Body 全量日誌。

## 實際變更路徑

| 檔案 | 作用 | 不變條件 |
|---|---|---|
| `member-system.js` | 僅當 `user.member.profile.save` 搭配 `accepted=true` 時附暫時性 `lineAccessToken` | 不影響其他 API/token，前端不判定資格 |
| `supabase/functions/_shared/member-oa-registration-gate.mjs` | 依核准 tenant 的 server-only 設定查驗綁定，再使用 #164 LINE verifier | 無綁定或身份不符一律拒絕 |
| `supabase/functions/member-profile-api/index.ts` | 新 pending→active 前、Terms RPC 前執行 Gate | active 會員不被封鎖；無成功 Gate 不寫入 consent |
| `supabase/functions/api/index.ts` | 舊 API `user.member.profile.save` 同樣攔下未驗證首次啟用 | 不留 legacy 直接呼叫繞過 |
| `tests/member_oa_registration_gate*.test.js`、`tests/membership_terms_flow.test.js` | 靜態路徑、負向/跨租戶、現有會員與會員啟用前副作用驗證 | 不刪除其他測試/斷言 |

## AC — Given/When/Then

| AC | 情境 | 結果 | 測試 |
|---|---|---|---|
| AC-001 | Given A 店 OA 已核准且 user 正確加友；When pending 會員完成資料/條款；Then 只能透過真 LINE status=true 啟用 | 驗證器單元+原服務合成 positive；真人沙盒另驗 | `member_oa_registration_gate_behavior.test.js` |
| AC-002 | Given false/封鎖或惡意 client flag；When direct-call 任一啟用 API；Then 403、不觸發 RPC | 合成 fail-closed/靜態順序、動態 Member Profile handler | `member_oa_registration_gate.test.js`、`membership_terms_flow.test.js` |
| AC-003 | Given A 店登入身分、B 店參數/Channel、缺 linked、錯 LIFF；When 檢查；Then 未變更會員 | Binding helper 單元，真多店 DB/E2E 待辦 | `member_oa_registration_gate_behavior.test.js` |
| AC-004 | Given LINE provider 401/429/5xx/網路故障；When 註冊；Then fail closed 且不發券 | Helper 單元+API 合成故障；真人 provider 故障待辦 | `member_oa_friendship_gate.test.js`（#164）／本批測試 |
| AC-005 | Given 併發註冊兩次；When 重複；Then 同店 `members.line_user_id` 唯一、RPC `for update` 僅一次 pending→active | 新增 PostgreSQL 17 雙實體連線的鎖等待、首次啟用/重放、rollback 恢復驗收；實際結果以本輪最終 SHA Actions 日誌為準，推薦獎勵競態仍待驗 | `tests/integration/postgres/member-activation.cjs`；獎勵另驗 |
| AC-006 | Given active 會員之後封鎖 OA；When 修改資料或接受新條款；Then 不自動停權 | 合成 handler + helper | `membership_terms_flow.test.js` |

## 測試命令及交付 Gate

- 開發中：`node --test MemberWebsocket-dev/tests/member_oa_registration_gate.test.js MemberWebsocket-dev/tests/member_oa_registration_gate_behavior.test.js MemberWebsocket-dev/tests/membership_terms_flow.test.js MemberWebsocket-dev/tests/member_oa_friendship_gate.test.js`。
- 交付前最終 SHA 仍須完整 `test-memberwebsocket-dev.yml`（Node、DOM、Edge、PostgreSQL、Chromium、audit）、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`、PR 風險檢查、分支部署後 HTTP/Chromium smoke。
- LINE Login Provider/Linked member OA 必須真實人工核實，才可啟用秘密設定並進行真 LINE 註冊；用 mock 的測試不能取代。
- **本 PR 是 Draft；在全部測試通過、逐店 LINE 綁定及正式回復策略審核之前不可合併/部署。**

## 已知限制與回復

目前新的 Gate 將未配置的 **新會員首次啟用拒絕為 503**；若直接部署但沒有逐店核准清單，將阻擋所有新入會，因此不得未經配置就發布到可用環境。對既有 active 會員沒有新 Gate；需以完整回歸確認。

目前尚未新增**資料庫層防旁路的好友驗證收據約束**；未授權的 service role 使用或其他啟用入口仍需 #34/#156 完整盤點，不可宣稱已防所有路徑。候選 PR 沒有更改 SQL；revert 本 PR 移除新 Gate/前端 token 傳送，撤回或清除設定中的未使用後端鍵即可（不得暴露/變更真實憑證）。回復時需重跑完整 CI，確認 Netlify/Supabase 精確版本。

## PostgreSQL 17 驗收增量（2026-10-27）

沿用 CI 隔離服務、現有 business-runtime installer 與真實 RPC／trigger，新增七案：payload/legacy 兩種先後組合的雙連線競態、rollback 後等待者接手、兩店相同 LINE user 的條款隔離、錯誤輸入無副作用、直接 service-role 更新無 consent 拒絕，以及 anon/authenticated 兩種 RPC 拒絕。競態實際確認 pg_blocking_pids、commit 前不可見、commit 後一筆 consent 和一筆首次啟用稽核；A/B 店可各自完成一次入會，重放不能覆蓋首次生日、電話、稱謂、姓名或 joined_at。

命令：`node --test --test-concurrency=1 MemberWebsocket-dev/tests/integration/postgres/member-activation.cjs`，必須使用既有 `database.cjs` 核可的一次性 CI PostgreSQL 17 服務；不得填入遠端 Supabase 連線或生產帳密。

本增量僅測試／CI，不更改 Runtime、資料庫 migration 或 LINE 設定，因此產品效能比較不適用。新增測試尚需本輪 final SHA 執行成功才算驗證；不代表真 LINE、直接 Edge 呼叫、所有 service-role 旁路、推薦券競態或歷史全量 migration 已驗收。
