# Frontdesk LINE Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 各商家獨立櫃檯 LINE 入口、逐人審核與兩種權限，沿用預約通知並安全確認／拒絕。

**Architecture:** 新增平台私有人員資料與受限交易 RPC；獨立櫃檯 API 驗證其商家 LINE audience，不變更 owner-only 管理員授權。沿用既有加密通知憑證、outbox、通知格式與預約狀態語意。

**Tech Stack:** 現有 vanilla JS、Deno／Supabase JS 2.57.0、PostgreSQL、Node test、PGlite、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-18-frontdesk-line-booking-design.md`。使用者已確認「各商家獨立櫃檯入口、逐人授權」。

## Global Constraints

- 來源 `45978b9b8a0d393297d14f739cbbbd3a0c47bc88`；目標 Integrated-Marketing-Platform；只發布開發環境 bmwhojszsnxliekkhrka。
- 櫃檯權限 `notify_only`、`review`；預設 notify_only；狀態 pending／approved／rejected／suspended。
- 不放寬 admin owner-only，不回落至其他 LINE token，不新增固定 sleep／輪詢／依賴。
- 必須同一交易重查授權與預約版本，保留既有資料與原通知。
- 全套既有 CI 與新增必要案例通過後才可合併發布；LINE 真實收件缺少證據時明確列受阻。

## Review Focus

1. Login Channel 與 OA 並非因 token 有效就能推論相互綁定；必須以已登入人的可信 OA 檢查驗證。
2. 停用與同時預約寫入須有交易序，不能只有 Edge 檢查。
3. 一個事件對多管理員不能倍增櫃檯通知；零管理員收件人仍須產生櫃檯通知。
4. 取消申請中與票券預留狀態不得被櫃檯繞過。
5. 切換商家／身分與未知儲存結果不能讓舊結果覆寫或寫入自動重送。

### Task 1: 私有人員、設定與預約交易

**Files:** 新增 `supabase/migrations/<CLI timestamp>_frontdesk_booking_access.sql`；新增 `tests/integration/frontdesk_access.cjs`、`tests/integration/postgres/frontdesk-access.cjs`。

**Interfaces:** `platform_frontdesk_context(p_slug)` 提供伺服器可信商家與櫃檯通道；`platform_frontdesk_admin(p_actor,p_tenant_id,p_issued_at,p_action,p_body)` 處理擁有者設定／審核；`platform_frontdesk_request(p_tenant_id,p_actor,p_channel_id,p_issued_at,p_action,p_body)` 處理本人申請／狀態／預約讀寫。秘密只留既有 module_notification_routes envelope。

- [ ] Write／run RED：待審／notify_only 無法操作；review 只可處理自己商家 pending；權限／商家撤銷；並行與重送一致。
- [ ] 新增最小 migration，表與 RPC 授權、狀態、版本、request ID 及稽核。
- [ ] 延伸既有商家與 provisioning 的 outbox 通道與通知選取，不複製管理員身分。
- [ ] Run GREEN：PGlite；真實 PostgreSQL CI 加入併發與升級／新建／回復。
- [ ] Commit Task 1。

### Task 2: LINE 驗證、受限 API 與第三通知通道

**Files:** 新增 `_shared/frontdesk-handler.mjs`、`frontdesk-api/index.ts`；修改 `platform-handler.mjs`、`platform-policy.mjs`、`business-runtime.ts`、`notification-routes.mjs`、`booking-line-notifications/*`；新增 handler／delivery 行為測試。

**Interfaces:** 管理端使用 `platform.frontdesk.get`／`.settings.save`／`.staff.save`。櫃檯使用 `frontdesk.public`／`.apply`／`.bootstrap`／`.bookings`／`.booking.update`；所有 actor/audience 由伺服器驗證。通知 config 帶 frontdesk token、關閉旗標及實際入口；兩種訊息共用 formatter。

- [ ] Write／run RED：錯 audience、origin、偽造 actor、未知 action、壞 token／envelope 不送至其他通道；notify_only 無操作入口。
- [ ] 使用現有 LINE verifier／加密封裝，API 大小限制、速率限制、CORS、錯誤映射。
- [ ] LINE 申請透過已驗證 LIFF access token 與 friendship API 檢查已綁定 OA，再以同 bot token profile 查核 sub 可達性；不以 bot/info 推論綁定。
- [ ] dispatch 前重新查權限，原 retry key／租約不變；同版部署函式清單納入新 API。
- [ ] Run GREEN：Node、Edge、通知回歸；Commit Task 2。

### Task 3: 管理端與櫃檯頁

**Files:** 新增 `frontdesk/index.html`、`frontdesk/app.js`、`frontdesk/styles.css`、`admin/frontdesk-settings.js`；修改管理頁掛載、`scripts/build-site.mjs`；新增 DOM／Chromium 測試。

**Interfaces:** 管理面板掛在預約 LINE 設定，同樣利用現有 merchant adapter 或 MemberAdminSession；櫃檯 URL 包含 business，通知可指定 bookingId。

- [ ] Write／run RED：逐人設定、待審、只通知、review；深色／窄螢幕／鍵盤；舊請求與不明結果不重送。
- [ ] 實作設定／人員管理、待審清單、確認／拒絕與 conflict 回復；僅必要預約資料。
- [ ] Run GREEN：DOM／Chromium／建置產物、資產 bytes 與請求數比較；Commit Task 3。

### Task 4: 完整回歸、審查與開發發布

**Files:** `.github/workflows/test-memberwebsocket-dev.yml`、Edge manifest／config、交付證據。

**Interfaces:** 最終 SHA 的全部既有 CI、DB migrations、Edge 版本與 Netlify deploy 綁定；不得使用正式 project ref。

- [ ] 執行本輪所有 AC 與完整既有 CI，記錄 pass/fail/skip 及未完成外部驗收。
- [ ] 獨立整體審查；重大問題先 RED→GREEN，重跑基線。
- [ ] 開 development PR，同 SHA 全綠後合併並等待開發 SQL→Edge→Netlify 發布。
- [ ] 真實開發站 HTTP／API 拒絕／資產 smoke；若缺櫃檯 OA 設定或核可收件人，明列真實 LINE 受阻，不稱功能已驗證完成。

## 執行紀錄

原生執行於此任務新 clone 的獨立 feature 分支；不另建重複 checkout。Progress ledger：`.superpowers/sdd/2026-11-18-frontdesk-line-booking/progress.md`。

## 本輪交付狀態

Task 1–3 程式與本機 SQL/API/DOM/Chromium/Edge 驗證已執行；實體 PostgreSQL 與原完整 CI 尚未執行，Task 4 保持受阻。六個獨立審查 Important 問題已 RED→GREEN；不把草稿、單元測試或 skip-CI 當作完成／發布依據。詳見 `docs/frontdesk-line-booking-20261118-report.md`。
