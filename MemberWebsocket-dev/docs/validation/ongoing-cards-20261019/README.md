# 進行中卡片：權限生命週期與設定治理

目標分支：Integrated-Marketing-Platform。基線：8328e10d349b1b6c87565d5d52d6858abcf30431。

## 已確認問題與決策

- #184：原 API 對 `platform.tenant.resume` 回傳 404 ACTION_NOT_FOUND，UI 沒有復權操作；原 schema 無使用期限。
- #181：狀態、期限、grant 各自保存。停權後復權只恢復 active，不延長期限、不恢復撤銷 grant。停權／到期資格延長後只接受撤銷時間之後由 LINE 簽發的 token；不發明新認證協定。
- 單一交易與 expectedVersion 防止雙分頁覆蓋。requestId 重試只產生一次變更及稽核，任何稽核失敗會回滾整筆操作。使用期限存 timestamptz UTC，介面明示台灣 UTC+8。
- #183：各模組的用戶 Channel、LIFF、通知憑證獨立保存；管理員登入身分由商家共用並在功能頁唯讀。舊 ciphertext 保留原 AES-GCM 綁定範圍，新寫入按 tenant+feature 綁定。舊配置先保留，既有模組不因共用頁改動而被覆蓋。
- 敏感資料只在私有 schema；anon/authenticated 無表及 RPC 存取權。前端只回傳設定 metadata，永不回傳 token/secret/envelope。未授權模組不可修改設定。
- 固定票券排程使用 events 憑證；一般會員權益通知使用 membership（只核准 points 時使用 points）；預約通知使用 booking。混合權益通知維持同一會員通知，不拆成多封。

## 設定盤點與處置

`scripts/config-inventory.mjs` 只輸出 Key、來源與行號，結果見 config-inventory.json。它不讀取環境值。

2026-10-19 由連接器查得（僅名稱）：

| 來源 | Key | 決策 |
|---|---|---|
| Netlify site env | 空清單 | 沒有 site env 可清理；GitHub Actions 部署憑證不屬於此清單 |
| Vault | BOOKING_NOTIFICATION_DISPATCH_SECRET / E2E_ARTIFACT_RETENTION_SECRET / GRANT_MESSAGE_DISPATCH_SECRET | 背景工作驗證，保留 |
| Vault | LINE_BOOKING_ADMIN_CHANNEL_ACCESS_TOKEN / LINE_BOOKING_MEMBER_CHANNEL_ACCESS_TOKEN / LINE_MESSAGING_CHANNEL_ACCESS_TOKEN | 舊業務與相容路徑仍有引用，保留 |
| Vault | platform_credential_encryption_v1 | 加密金鑰來源，保留；不可直接替換以免既有資料無法解密 |
| Vault | project_url | 排程呼叫來源，保留 |
| line_config.settings | messaging_channel_access_token / booking_admin_channel_access_token / booking_member_channel_access_token / event_ticket_liff_url | 舊業務讀取／回退來源，保留 |
| Supabase Edge Secrets | 尚無完整清單 | 連接器未提供清單工具；CLI `secrets list` 因缺少 access token 受阻，沒有讀取任何值、沒有刪除 Key |

LINE Developers 的實際 callback、Provider 關係、Webhook 驗簽與對外傳訊仍需提供者核可測試帳號或沙盒；fixture 通過不代表已完成此項。#183 在這些必要證據補齊前保持未完成，不盲刪變數。

## 驗收與可重現命令

| 驗收 | 測試 |
|---|---|
| AC-181-001/002/003/006、AC-184-01～08 | tests/integration/admin_access_lifecycle.cjs、tests/admin_access_lifecycle.test.js |
| AC-181-004、AC-184-09 | tests/browser/admin-access-lifecycle.spec.cjs、tests/portal_navigation.test.js |
| AC-181-005、AC-ENV-002/003/005 | business-activation.spec.cjs、admin_access_lifecycle.cjs、_shared/business-runtime_test.ts |
| AC-181-007、AC-184-10 | 全專案既有 CI，包括 regression、integration、browser、syntax、Edge typecheck/tests、wiring、dependency audit |
| AC-ENV-001/004 | 部分：已盤點 source/Vault/line_config/Netlify；Edge Secret metadata 與提供者 sandbox 實測受阻，未移除舊設定 |

```sh
node --test MemberWebsocket-dev/tests/*.test.js
node --test MemberWebsocket-dev/tests/integration/admin_access_lifecycle.cjs
cd MemberWebsocket-dev/tests/browser && npm test
# CI 中另外依 .github/workflows/test-memberwebsocket-dev.yml 執行完整基線。
```

本機 PGlite 為真實隔離 PostgreSQL 執行引擎；LINE HTTP 使用明示 stub。新增測試涵蓋既有結構升級、冪等、競爭、交易失敗回滾、RLS、期限邊界與模組憑證綁定。本機原生瀏覽器 SIGTRAP、Deno 缺 /proc/self/exe；兩者交由 GitHub CI 執行，未把本機受阻計為通過。

## 部署與回復

先套用 `20261019122719_admin_access_lifecycle.sql`，再套用 `20261019122917_module_line_scope.sql`，再部署受影響 Edge Functions。最後由完整 CI 成功的目標提交發布 Netlify `integrated-marketing-platform` alias，核對頁面版本、JS 及未登入 API 拒絕。

遷移為新增欄位／私有表，保留舊資料與憑證，不改正式帳號角色。若部署冒煙失敗，停止發布前端並修正 Edge；不能回到會繞過期限／憑證撤銷的舊程式。可用既有停權 RPC 暫停受影響商家後修正前進；修正與重新部署後由已授權總管理員決定復權，不自行授予權限。不得刪除新增的撤銷時間或 ciphertext 來「修復」。正式資料未執行破壞性測試。
