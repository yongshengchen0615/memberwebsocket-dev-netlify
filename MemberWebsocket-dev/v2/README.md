# MemberOS V2 — 全新 Supabase / HTML / CSS / JavaScript

## 狀態與目標

本分支 `feature/supabase-v2-greenfield` 重新製作前端與平台控制 API，**不匯入任何舊版前端流程**。

本階段完成的是 **新控制平面 + 申請/核准/功能授權 + 商家 LINE 設定架構**。會員、集點、活動票券、預約等 **八個業務資料平面仍待重新實作**，不可把功能卡片的「已授權」視為整套會員業務已可使用；商家正式啟用仍受資料庫環境驗證約束。

依使用者已確認的資料策略，正式會員資料必須保留直到隔離環境遷移校驗完成，**不能直接清空現有 Supabase 專案**。本 V2 分支 Netlify build 只輸出 V2，不輸出舊 HTML/CSS/JS；正式站繼續使用原分支，避免資料不可回復。

## 架構

```text
V2 網站（全新 HTML / CSS / JS）
 ├ /             首頁
 ├ /admin        管理員 LINE 認證、申請、待審與 LINE 設定
 └ /platform     總管理員 LINE 認證與八項功能審核
       │
       └ HTTP POST → V2 Platform Edge Function（LINE ID token 每次驗證）
              │
              └ NEW Platform Supabase Project
                 ├ private schema: operators, applications, tenants, secrets, jobs, audit
                 ├ public RPC: SQL SECURITY INVOKER, service_role 專用
                 └ Provisioning job queued：未取得費用授權不得啟動
                         │
                         └ 每個商家獨立 Supabase Project（後續佈建）
```

V2 必須使用新 Supabase Project，Edge Function 若偵測到舊專案 ref `dbuquirnaskrwcamdxki` 會拒絕啟動。公開設定只包含 V2 API URL 與 LIFF ID，不含 Supabase Secret / service_role / 資料庫密碼。秘密只能設在 V2 Edge Function 的受保護環境變數。

## 建置與發佈

本地乾淨建置：
```bash
node scripts/build-v2-site.mjs
```
輸出到 `dist/`，內容只含 V2 靜態網站。預設 `config.json` 的 V2 連線為空，畫面顯示未配置，不會改用舊專案。

取得平台擁有者核准，建立 **全新的** Platform Supabase Project 後，再設定 Netlify「分支專用」非秘密變數：
```text
V2_PLATFORM_FUNCTION_URL=https://<NEW_PLATFORM_REF>.supabase.co/functions/v1/platform-v2
V2_PLATFORM_LIFF_ID=<平台專用 LINE LIFF ID>
```
建置指令會驗證兩者必須同時存在、URL 必須指向新專案及 `/functions/v1/platform-v2`，並拒絕舊 Supabase 專案。

部署到 **新 Supabase Platform Project** 的 Edge Secrets（不可放在 Git 或 Netlify 前端變數）：
```text
V2_SUPABASE_URL=<NEW_PLATFORM_SUPABASE_URL>
V2_SUPABASE_SECRET_KEY=<NEW_PLATFORM_SECRET_KEY>
V2_LINE_CHANNEL_ID=<平台專用 LINE Login Channel ID>
V2_ALLOWED_ORIGINS=<精確的 HTTPS 網站來源，逗號分隔>
V2_LINE_ENCRYPTION_KEY=<安全隨機 32-byte key 的 Base64 表示>
```
Edge Function 的 Supabase gateway JWT 驗證必須針對此 LINE ID token 流程明確關閉；取代它的是後端逐次向 LINE Verify ID Token API 驗證 `aud`、`iss`、`sub`、`iat`、`exp`。不可將 `verify_jwt=false` 套用到其他業務 API。

資料庫：僅針對 **新、空白、隔離的 Platform 測試專案**，先載入 `supabase/plans/p1_control_plane_schema_sandbox_ONLY.sql`，再載入 `v2/sql/01_platform_v2_rpc_sandbox.sql`。SQL 皆為未部署的沙盒參考，不是已驗證的正式遷移檔。正式部署前，必須透過安裝的 Supabase CLI 建立版本化 migration 並執行新庫與升級庫測試。

**絕不可在舊 Supabase 專案上執行這兩份 SQL。** 不得將資料庫 root 操作者權限交給平台 API。新 `platform_operators` 預設為空；任何新增或啟用總管理員都必須經獨立資料庫操作者確認身分後手動完成，不得透過 V2 前台自行升權。

## 第一性原理驗收

| 編號 | Given / When / Then | 交付測試 |
| --- | --- | --- |
| AC-V2-001 | Given 新空白 Platform DB, When 初始化，Then 零 Root、私有 RLS、anon/authenticated/service_role 都不能寫 root | `integration/platform_v2.cjs` |
| AC-V2-002 | Given 已認證管理員，When 首次開啟 V2 Admin，Then 只有待審核申請、不建立商家；Given Root 核准，When 重送 request_id，Then 只建立一筆待佈建商家和 job | SQL/Chromium |
| AC-V2-003 | Given 非 Root，When 變更八項功能權限，Then 拒絕；Given Root，When 修改功能，Then 只變更授權與稽核，不變更 LINE | SQL/Chromium |
| AC-V2-004 | Given 已核准商家且功能啟用，When 設定 LINE，Then 加密且憑證不在回應；停權/未授權/跨商家皆拒絕 | SQL、Web Crypto、handler |
| AC-V2-005 | Given 商家環境未完成隔離，When 強行 active，Then 約束拒絕；When 降級已啟用商家環境，Then 需先停權 | P1 SQL |
| AC-V2-006 | Given 舊資料依然運作，When 建置 V2，Then 不打包舊版網站、不默默連回舊 Supabase | `v2_build.test.js` |
| AC-V2-007 | Given 非法 LINE token、假冒 Root / 非法來源與大量輸入，When 呼叫 V2 API，Then 在寫入前拒絕 | `platform_v2.test.js` |
| AC-V2-008 | Given 兩個完成佈建的商家專案，When 跨商家 API/Storage/Realtime/票券/預約，Then 完全隔離 | **尚未實作，阻擋正式上線** |
| AC-V2-009 | Given 新舊資料遷移演練，When 比對 DB、Auth、Storage、Cron、LINE，Then 資料無遺漏並可安全回切 | **尚未執行，阻擋正式上線** |

## 測試

```bash
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration
node --test MemberWebsocket-dev/tests/platform_v2.test.js MemberWebsocket-dev/tests/v2_build.test.js MemberWebsocket-dev/tests/integration/platform_v2.cjs
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser
npm test --prefix MemberWebsocket-dev/tests/browser -- v2-platform.spec.cjs
node scripts/build-v2-site.mjs
```
對應 CI：`.github/workflows/test-v2-greenfield.yml`，同時原有 `test-memberwebsocket-dev.yml` 繼續跑全專案基線。真實 LINE HTTP、真實跨專案、付款建立 Supabase 專案、遷移/回復演練不能以 stub 或 PGlite 結果取代。

## 回復與剩餘問題

任何 V2 新頁面問題，將 Netlify 來源切回原 production/develop 部署即可；不須在正式資料庫執行 DROP、TRUNCATE 或資料刪除。已建立的 V2 資料庫只以隔離測試資料運作時，可獨立重置，正式資料不適用。

未完成：新 Platform Project 成本及存取權授權、實際部署及 E2E、新商家 Project Provisioner/重試與對帳、八項新業務功能、商家 A/B 完整隔離、真實 LINE 身分綁定、Storage/cron/messaging 遷移、舊資料一致性/備份回復、正式入口切換。**不得聲稱已完成會員系統重建或可上線。**
