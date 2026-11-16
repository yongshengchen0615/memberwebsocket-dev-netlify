# MemberWebsocket Dev — Netlify

Copied from `yongshengchen0615/yongshengchen0615.github.io`, commit
`c1eb08e26a63862d88d91e57a4eda52a11246e5b`, directory `MemberWebsocket-dev`.
The original directory is preserved so existing application and test paths keep working.

## Build and serve

Node.js 24 is required. No dependency installation is needed for the static build.

```bash
node scripts/build-site.mjs
python -m http.server 8080 --directory dist
```

The build publishes only frontend assets. Supabase functions, migrations, tests,
internal documents and local Netlify state are excluded from `dist`.

> **正式環境全端同步／合併阻擋：** 網站、Supabase SQL/RLS/RPC/Trigger 與 Edge Functions 的發布程序、尚未完成的一次性 migration 歷史對帳、需要的 GitHub Secrets 和回復條件，請參考 [完整正式發布規範](docs/FULLSTACK_PRODUCTION_PROMOTION.md)。在正式資料庫基線驗證完成前，不可宣稱「合併 master 即已同步後端」。

## Netlify configuration

Use the recreated project `memberwebsocket-dev-netlify`
(`196e1d2c-8216-4ba8-aeb9-1706660adc2b`). The currently connected production branch is `master`. The `Integrated-Marketing-Platform` development branch uses a **native Netlify branch deploy**, published after exact-SHA CI succeeds, at `https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/platform/`. The GitHub release workflow validates the existing native deploy, reproduces its build artifact, verifies public files, CORS, and read-only Chromium E2E, and never uploads a competing branch ZIP. The production `master` release is handled separately by `publish-netlify.yml`.
Leave the base and package directories empty. The root `netlify.toml` sets:

- Build command: `node scripts/netlify-preview-source.mjs --build`
- Ignore command: `node ./scripts/netlify-preview-source.mjs --ignore`
- Publish directory: `dist`
- Node version: `24`

Production uses `dbuquirnaskrwcamdxki`; the testing branch uses `bmwhojszsnxliekkhrka`,
as selected by the scoped configuration below.
The client config contains a public publishable key. Do not add a service-role key
or server secrets to frontend code or the publish directory.
`.netlify/` is ignored because linking writes local project state there.

## 正式與測試 `config.json` 完全獨立

請只修改所屬環境的完整 JSON。**兩個檔案都叫做 config.json，但路徑不同**；
部署時只會讀取對應檔案，沒有共用的環境設定值，也不依賴 Netlify
環境變數，或 GitHub 的特殊合併驅動程式。此處指前端設定來源；發布憑證仍依下方「環境變數與設定來源」管理。

| Git 分支／部署目的 | 應編輯的檔案 | 固定 Supabase 專案 |
| --- | --- | --- |
| `master` 正式網站 | `MemberWebsocket-dev/config/production/config.json` | `MemberWebsocket-main` (`dbuquirnaskrwcamdxki`) |
| `Integrated-Marketing-Platform` 測試網站 | `MemberWebsocket-dev/config/testing/config.json` | `MemberWebsocket-test` (`bmwhojszsnxliekkhrka`) |
| 其他 Netlify Deploy Previews | 同 `config/testing/config.json` | `MemberWebsocket-test` |

兩個環境檔皆含 `brandName`、`realtimeEnabled`、各項 Supabase 設定、
兩組管理端 LIFF ID（`adminLiffId`、`platformLiffId`）、`productizedAdmin` 與 `merchantApprovalVersion`。
即使測試設定檔隨功能分支合併到 `master`，正式建置仍只讀取
`config/production/config.json`；正式設定檔被同步到測試分支時亦同。
**這是部署設定隔離，不是 Git 不會複製檔案：合併後兩份檔案仍會存在於同一程式碼樹。**

外層的 `MemberWebsocket-dev/config.json` **完全不再參與任何建置**（包含本機建置、CI、Netlify）。
正式與測試只讀 `MemberWebsocket-dev/config/production/config.json` 或
`MemberWebsocket-dev/config/testing/config.json`，由分支／部署環境選取。
建置器只發布被選中的完整設定到 `dist/config/config.json`；
總管理員頁面和 MemberSystem 直接取得 `/config/config.json`。
為了避免已開啟的舊版頁面失效，`dist/config.json` 暫時保留為
**同內容、建置時自動生成的相容副本**；絕不從外層原始 JSON 讀取它。
不會把兩份環境專屬來源同時發布到瀏覽器。

### 修改與驗收

1. 在 GitHub 選擇對應分支，進入表格列出的對應 `config.json`，修改所屬環境的公開設定。
2. 以 PR 走原有 CI；不可將測試的 Supabase 網址、錯誤的 publishable key、
   secret 或缺漏管理端 LIFF ID 放入目標設定檔。建置將在產出網站前拒絕錯誤設定。
3. 先比對兩種建置：`BRANCH=master CONTEXT=production node scripts/build-site.mjs`
   與 `BRANCH=Integrated-Marketing-Platform CONTEXT=branch-deploy node scripts/build-site.mjs`。
   兩次都會覆寫本機 `dist/`，因此要分別檢查各次 `dist/config/config.json`；舊版 `dist/config.json` 必須與它完全相同。
4. 合併及部署後，使用公開站台 `/config/config.json` 和已發布的 Git SHA
   核對實際 Supabase ref、LIFF、品牌及功能旗標；另外驗證 LINE Developers
   Endpoint、Supabase 後端 allowlist/LINE Channel 設定。

可執行的隔離與錯誤測試：

```bash
node --test scripts/branch-environment.test.mjs scripts/preview-member-runtime.test.mjs scripts/development-api-build.test.mjs
```

> LINE LIFF ID 是公開用戶端識別碼，可以存於上述公開設定檔。
> **不要**在任一 JSON 放入 LINE Channel Secret、Supabase service-role/secret key、
> Twilio Auth Token 或密碼。正式與測試目前**有部分 LIFF ID 不同**，
> 不代表 LINE Channel、Endpoint 及後端驗證已全部獨立；如需進一步隔離，應在測試設定檔填入測試 LIFF App IDs，
> 配合 LINE Developers Endpoint 與後端 Channel 驗證。

## LINE LIFF configuration

全域 `config.json` 僅保留 `platformLiffId`（總管理端）與 `adminLiffId`
（一般管理員登入、申請與商家選擇）。正式與測試各自使用所屬環境檔案的值。

會員卡 `memberLiffId`、集點卡 `pointsLiffId`、票券 `eventLiffId`、日曆
`calendarLiffId`、預約 `bookingLiffId` 一律在商家管理端的 LINE 設定中維護。
商家設定內另有自己的管理入口 `adminLiffId`，與全域帳號入口層級不同。
缺少功能 LIFF 時不再回退全域值；頁面提示補齊商家 LINE 設定。

功能 LIFF 的 LINE Developers Endpoint 必須使用設定頁提供的完整網址，
包含 `?business=<商家代碼>`，並對應正式或測試站台。
沒有商家代碼的功能網址不再提供全域功能登入；請使用商家專屬入口。
本次僅精簡公開設定，不刪除 LINE Developers 上的 App、不修改商家資料或憑證。

實際 LINE 登入需另外使用授權帳號驗收；自動化 fixture 不代表外部登入通過。

## 環境變數與設定來源

**先選對環境，再填設定。** 正式使用 `MemberWebsocket-main`，測試使用
`MemberWebsocket-test`；兩個 Supabase 專案的秘密設定、Vault 與商家資料分開維護。
下表中的「必填」是功能使用條件，不表示要重新建立已正常運作的憑證。
本節依目前程式實際讀取的名稱整理，不會列出或要求公開任何秘密值。

### 設定要放在哪裡

| 類型 | 設定位置 | 什麼時候需要 |
|---|---|---|
| 前端公開設定 | 上方環境對照表的 `config/production/config.json` 或 `config/testing/config.json` | 兩環境均需要；只有公開 URL、publishable key 與兩個管理 LIFF |
| GitHub 發布憑證 | [Repository → Settings → Secrets and variables → Actions → New repository secret](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/settings/secrets/actions) | 自動發布 Netlify 時需要 |
| Netlify 建置設定 | [Netlify 專案](https://app.netlify.com/projects/memberwebsocket-dev-netlify) → Project configuration → Environment variables | 原生測試分支建置查詢 GitHub CI；發布標記由工作流程管理 |
| Supabase 後端變數 | [正式專案](https://supabase.com/dashboard/project/dbuquirnaskrwcamdxki)／[測試專案](https://supabase.com/dashboard/project/bmwhojszsnxliekkhrka) → Edge Functions → Secrets | 會員 OA 對應、啟用簡訊驗證、自訂網域或既有後端覆寫 |
| 商家 LINE 設定 | 一般管理端 → 選擇商家 → LINE 設定 | 各商家功能 LIFF、Login Channel 與通知帳號；不是全域環境變數 |
| 資料庫內部秘密 | 對應 Supabase 專案 → Vault | 既有 migration 管理的加密金鑰、排程密鑰與排程專案 URL；不是 Netlify 變數 |

### 前端 `config.json`：公開值怎麼找

| 欄位 | 用途／取得方式 | 正式與測試 |
|---|---|---|
| `supabaseUrl` | Supabase Dashboard 選對專案，在 Connect／Settings → Data API 確認 Project URL；格式 `https://<project-ref>.supabase.co` | 正式 `https://dbuquirnaskrwcamdxki.supabase.co`；測試 `https://bmwhojszsnxliekkhrka.supabase.co` |
| `supabaseFunctionUrl` | 使用同一個 `supabaseUrl` 加上 `/functions/v1/api`，不必另外申請金鑰 | 必須對應同環境 |
| `supabasePublishableKey` | Supabase Dashboard → Settings → API Keys → Publishable keys，複製 `sb_publishable_...` | 各自從所屬專案取得；不可填 service-role／secret key |
| `adminLiffId` | [LINE Developers Console](https://developers.line.biz/console/) → 一般管理端使用的 LINE Login Channel → LIFF → 該 App 的 LIFF ID | 各環境使用自己的入口；不是單獨的 Channel ID |
| `platformLiffId` | 同上，選總管理端使用的 LIFF App，複製 LIFF ID | 與一般管理端分開，Endpoint 對應所屬站台 |
| `brandName`、`realtimeEnabled` | 品牌名稱與 Realtime 功能選擇，沒有外部供應者憑證要找 | 沿用各環境目前設定即可 |
| `productizedAdmin`、`merchantApprovalVersion` | 本專案的管理入口／審核流程旗標；目前為 `true`、`2` | 一般設定環境時維持現值 |
| `__environmentNotes` | 編輯說明，建置時移除 | 不會發布到瀏覽器 |

這些是 **JSON 欄位，不是要新增到 Netlify 的環境變數**。
`PUBLIC_LIFF_CONFIG_PRODUCTION`、`PUBLIC_LIFF_CONFIG_TEST` 不再作為覆寫來源。
會員卡、集點、票券、日曆、預約的五個功能 LIFF 只在商家的 LINE 設定維護，
不要加回全域 JSON。

### GitHub Actions：Netlify 發布憑證

| 名稱 | 是否手動設定 | 從哪裡取得／怎麼填 |
|---|---|---|
| `NETLIFY_AUTH_TOKEN` | 自動發布必填；存為 **GitHub Repository Secret** | Netlify 使用者設定 → Applications → Personal access tokens → New access token；使用有權發布本專案的帳號建立並複製。GitHub 兩個發布 workflow 都讀取同名 Secret；只設在 Netlify Environment variables 不會供應給 GitHub Actions |
| `NETLIFY_SITE_ID` | 目前不用新增 Secret，發布 workflow 已設定 | Netlify → Project configuration → General／Project details → Project ID。本專案為 `196e1d2c-8216-4ba8-aeb9-1706660adc2b`；若換站台，須同步檢查兩個發布 workflow 的 job 設定與站台綁定 |
| `GH_TOKEN`／`GITHUB_TOKEN` | 不必自己建立同名 Secret | 現有 workflow 使用 GitHub 自動提供的 `${{ github.token }}`，並依 workflow permissions 查詢 CI；它不是下面 Netlify 建置用的 PAT |
| `PROJECTS_V2_TOKEN` | 一般建置、網站發布不需要 | 僅保留的 Project #5 歷史狀態修復 workflow 使用。若要執行該工作，至 GitHub 個人 Settings → Developer settings → Personal access tokens，建立可讀寫該 Project 的權杖，再存為 GitHub Repository Secret；classic PAT 的 Project 修改需要 `project` scope，私有 repository 讀取另需相應權限 |

發布來源：[`publish-netlify.yml`](.github/workflows/publish-netlify.yml) 與
[`publish-platform-preview.yml`](.github/workflows/publish-platform-preview.yml)。
不要把 Netlify access token 寫進 README、`config.json` 或 `netlify.toml`。

### Netlify：建置查詢與自動變數

| 名稱 | 是否手動設定 | 來源／作用域 |
|---|---|---|
| `NETLIFY_GITHUB_READ_TOKEN` | 建議設定；公開 repository 可不填，未認證查詢會受較低 API 流量限制 | GitHub 個人 Settings → Developer settings → Personal access tokens → Fine-grained tokens，選本 repository、Repository permissions 的 Actions = Read-only（Metadata 維持可讀）。貼入 Netlify Environment variables，標記為秘密，作用域包含 Builds，涵蓋 `Integrated-Marketing-Platform` 分支建置。此值供 Netlify 查詢 GitHub CI，不是 Netlify access token |
| `PLATFORM_CI_VERIFIED_SHA` | **不要手動填或複製舊值** | GitHub 發布流程確認當版 CI 成功後，寫入 Netlify 的 `branch:Integrated-Marketing-Platform`／Builds；必須等於當次 `COMMIT_REF` |
| `NODE_VERSION` | 通常不用手動設定 | [`netlify.toml`](netlify.toml) 已固定為 `24` |
| `NETLIFY`、`BRANCH`、`CONTEXT`、`COMMIT_REF`、`DEPLOY_ID`、`BUILD_ID`、`SITE_ID`、`SITE_NAME` | 不用手動建立 | Netlify 建置環境依站台、分支、部署自動提供；不要改成固定正式或測試值 |
| `NETLIFY_SITE_ID`、`PREVIEW_SOURCE_BRANCH`、`PLATFORM_ALIAS`、`PREVIEW_BASE_URL`、`NATIVE_NOT_BEFORE`、`VERIFIED_PREVIEW_SOURCE_EPOCH` 等發布／驗證參數 | 不用照名稱逐一新增 | 由現有 GitHub 發布 workflow、Netlify 來源資訊或驗證腳本計算；不是應用程式登入所需的額外憑證 |

Netlify 自訂變數變更後，需重新建置才會套用到建置流程。
Netlify 的變數不會自動傳到 Supabase Edge Functions，也不會取代環境專屬 JSON。

### Supabase Edge Functions：後端需要的設定

進入**所屬環境的** Edge Functions → Secrets 管理自訂項目。
下表均不是前端設定；同名項目在兩個 Supabase 專案各自生效。

| 名稱 | 必要性／用途 | 值從哪裡取得 |
|---|---|---|
| `MEMBER_OA_VERIFIED_LINKS_JSON` | 新會員的官方帳號好友驗證對應；使用目前首次入會流程時須完成。缺漏會阻止首次啟用，不能靠前端勾選略過 | 先在 LINE Login Channel → Basic settings → Linked LINE Official Account 確認實際綁定，再組合下方經確認的商家 UUID、Login Channel ID、官方帳號 ID |
| `PLATFORM_CREDENTIAL_ENCRYPTION_KEY` | 既有明確設定的加密金鑰優先；若未設，程式由 `platform_credential_key()` 讀 Vault，通常不必再新增 | 沿用目前實際生效的 32-byte Base64 金鑰。migration 已可在所屬專案 Vault 建立 `platform_credential_encryption_v1`；不要拿另一環境或新產生的金鑰覆蓋已使用的值，否則既有商家憑證無法解密 |
| `ALLOWED_ORIGINS` | 新增自訂網域時才需要；精確 Origin 以逗號分隔，不含路徑／結尾斜線 | 從實際使用的網站網址取得，例如 `https://your-domain.example`。目前程式內建既有 Netlify 來源；此值是**追加**白名單，不能靠它刪除內建來源，不使用 `*` |
| `GRANT_MESSAGE_DISPATCH_SECRET` | 選用的排程派發覆寫；未設時讀資料庫 `get_grant_dispatch_secret()` | 沿用同專案 Vault 中 `GRANT_MESSAGE_DISPATCH_SECRET` 與排程使用的密鑰；不要另填不一致的值。它不是 LINE 或 Twilio token |

`MEMBER_OA_VERIFIED_LINKS_JSON` 的格式如下，僅為格式範例；須替換為**已確認綁定**的資料：

```json
[
  {
    "tenantId": "00000000-0000-4000-8000-000000000001",
    "memberLoginChannelId": "1234567890",
    "memberOaId": "@example"
  }
]
```

- `tenantId`：選對 Supabase 專案後，可用 SQL Editor 執行
  `select id, slug from platform_private.tenants order by slug;` 找到商家 UUID。
- `memberLoginChannelId`：LINE Developers → 該商家的 LINE Login Channel → Basic settings → Channel ID，必須與會員功能使用的 Channel 一致。
- `memberOaId`：所綁定 LINE 官方帳號的 Basic ID／Premium ID（`@` 開頭），在 LINE Official Account Manager 的帳號設定確認；不是 Messaging API Channel ID。
- 不能以猜測或只抄 LIFF 前綴視為官方帳號綁定已驗證；不要把同一會員 Login Channel 對應到不同商家。

#### Twilio：啟用手機驗證才設定

這五項同樣放在對應 Supabase 專案的 **Edge Functions → Secrets**。
本專案目前使用 API Key SID／Secret，不讀取 `TWILIO_ACCOUNT_SID` 或 `TWILIO_AUTH_TOKEN`。

| 名稱 | 取得位置／內容 | 啟用條件 |
|---|---|---|
| `TWILIO_VERIFY_SERVICE_SID` | [Twilio Console](https://console.twilio.com/) → Verify → Services → 選擇或建立服務 → Service SID（`VA...`） | 啟用 OTP 時必填 |
| `TWILIO_API_KEY_SID` | Twilio Console → Settings → Account settings → API keys & auth tokens → Create API key，取得 `SK...`；舊版介面為 Admin → Account management → Keys & credentials → API keys & tokens | 啟用 OTP 時必填；須屬於該 Verify Service 的帳號 |
| `TWILIO_API_KEY_SECRET` | 建立上述 API Key 時顯示的 Secret；只顯示一次，建立時安全保存，遺失時不能從 Secret 名稱讀回 | 啟用 OTP 時必填，不可公開或放進 JSON |
| `TWILIO_VERIFY_ALLOWED_COUNTRY_CODES` | 由業務決定的 E.164 國碼，以逗號分隔；未設時預設 `+886` | 與 Twilio Verify 的 Geo Permissions 配合，只開需要的國家 |
| `TWILIO_VERIFY_REQUIRED` | 未設時不啟用；準備期間維持 `false`，完成憑證與實際驗證測試後才設 `true` | 三個必要值缺漏或留空時，不要啟用，否則新入會／換號驗證會受阻 |

完整 OTP 流程、開關影響與測試見
[`twilio-verify-first-join.md`](MemberWebsocket-dev/docs/twilio-verify-first-join.md)。
Secrets 名稱存在或 CI fixture 通過，不代表 Twilio 真正發送成功。

#### 平台自動提供／舊版相容項目

| 名稱／類型 | 如何處理 |
|---|---|
| `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` | Hosted Edge runtime 由 Supabase 注入，這個版本的後端直接讀取；不必自行新增同名 Secret。若需核對 URL／legacy service-role key，進所屬專案 Settings → Data API／API Keys；service-role 僅限伺服器，絕不填入前端。現在 Supabase Dashboard／Management API 保留 `SUPABASE_` 前綴，不能以自訂 Secret 新增這些名稱 |
| `SUPABASE_PUBLIC_URL` | 程式支援部署層提供公開 URL 的情境，未提供則使用 `SUPABASE_URL`。這不是要求在 Hosted Dashboard 新增的項目；同樣受保留前綴限制。自架部署若有內部 URL，公開 URL 必須與所屬專案匹配 |
| `LINE_ADMIN_CHANNEL_ID`、`LINE_MEMBER_CHANNEL_ID`、`LINE_POINTS_CHANNEL_ID`、`LINE_EVENT_CHANNEL_ID`、`LINE_CALENDAR_CHANNEL_ID`、`LINE_BOOKING_CHANNEL_ID` | 舊版／非商家作用域驗證仍有相容讀取；有使用這些路徑時才依 LINE Developers → 對應 LINE Login Channel → Basic settings → Channel ID 維護。新商家的功能身分取自商家設定；平台帳號管理驗證由兩個管理 LIFF 所屬環境設定解析，不靠新增一組全域功能 LIFF |

### 商家 LINE 憑證與 Vault：不要放錯位置

| 要設定的內容 | 從哪裡找 | 放在哪裡 |
|---|---|---|
| 商家管理入口與五項功能 LIFF ID | LINE Developers → 對應 LINE Login Channel → LIFF → LIFF ID | 商家的 LINE 設定；Endpoint 使用頁面提供、含 `business` 的所屬環境完整網址 |
| Login Channel ID | 該 LINE Login Channel → Basic settings → Channel ID | 商家的登入帳號細節；介面會從 LIFF ID 帶入，但仍須確認 |
| 通知用 Messaging API Channel ID | 該 Messaging API Channel → Basic settings → Channel ID | 商家的通知帳號設定 |
| 通知用 Channel access token | 該 Messaging API Channel → Messaging API → Channel access token (long-lived) | 商家的通知憑證欄位；它不是 LIFF ID token |
| 通知／Webhook 的 Channel secret | 同一 Messaging API Channel → Basic settings → Channel secret | 商家的通知憑證欄位；需要通知／Webhook 時才填 |
| `platform_credential_encryption_v1`、`GRANT_MESSAGE_DISPATCH_SECRET`、`BOOKING_NOTIFICATION_DISPATCH_SECRET` | 由既有 migration 在對應專案 Vault 建立；不是到 LINE／Twilio 申請 | Vault／既有 RPC 管理；`BOOKING_NOTIFICATION_DISPATCH_SECRET` 由 `booking_notification_config()` 讀取，不必另外加 Edge Secret |
| Vault 的 `project_url` | 本頁環境表對應的 Supabase 公開 URL | 同專案 Vault 的排程目標；不是瀏覽器的 Netlify 網址。不得把正式 URL 複製成測試專案的排程目標 |

商家通知憑證以加密形式儲存，儲存後的空白欄位通常表示保留既有秘密。
本 README 只說明來源與位置；不要為了填表而重發 token、替換加密金鑰、
刪除既有 Vault 值或改寫目前的商家設定。

### 建議設定與檢查順序

1. 依環境表選定分支、JSON 與 Supabase 專案，先核對 URL／Project ref。
2. 核對公開 publishable key 與兩個管理 LIFF；LIFF 的 Endpoint 亦須對應該環境。
3. 核對 GitHub `NETLIFY_AUTH_TOKEN`；需要 Netlify 原生建置查詢時，再設 Builds scope 的 `NETLIFY_GITHUB_READ_TOKEN`。
4. 在商家 LINE 設定填各功能入口；首次入會再完成經確認的 `MEMBER_OA_VERIFIED_LINKS_JSON`。
5. 需要手機 OTP 時，填 Twilio 三個必要值並實測，最後才啟用 `TWILIO_VERIFY_REQUIRED`。
6. 自訂網域依需要追加 `ALLOWED_ORIGINS`。設定錯誤時查所屬 Edge Function Logs；不要把所有 403 都當成 Origin 問題。
7. JSON 變更走既有建置／CI／發布流程；Netlify 建置變數變更後重新建置。Supabase 自訂 Secrets 更新後，依官方文件不必僅為此重新部署函式，但仍須測試受影響路徑。
8. 以公開 `/config/config.json`、部署版本和受保護 API 的拒絕結果核對；最後用授權帳號驗收 LINE 登入／簡訊，不能以未執行或 stub 通過代替。

來源核對：目前 repository 的 `netlify.toml`、發布 workflows、`business-scope.ts`、
`platform-key.mjs`、`member-profile-api/index.ts` 與相關 migrations。
官方介面名稱可能調整；可參考：
[Supabase Secrets](https://supabase.com/docs/guides/functions/secrets)、
[Supabase Secrets 限制](https://supabase.com/docs/guides/functions/limits)、
[Netlify CLI／access token](https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/)、
[Netlify 環境變數](https://docs.netlify.com/build/environment-variables/overview/)、
[GitHub Actions Secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)、
[GitHub Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)、
[LINE Login 與官方帳號連結](https://developers.line.biz/en/docs/line-login/link-a-bot/)、
[LINE Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)、
[Twilio API Keys](https://www.twilio.com/docs/iam/api-keys/keys-in-console)、
[Twilio Verify](https://www.twilio.com/docs/verify/api)。

## Tests

```bash
node --test scripts/deploy.test.mjs MemberWebsocket-dev/tests/*.test.js
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser
```

The copied `.github/workflows/test-memberwebsocket-dev.yml` defines the full existing
DOM/database integration, browser E2E, JavaScript syntax, Edge Function and wiring
test lanes. `test-netlify-build.yml` checks the static publish output separately.
Browser fixture tests do not establish that external LINE login works on Netlify.
DOM/PGlite and Chromium fixtures use Node.js 22 in CI; static builds and Node regression use Node.js 24.

## Recovery

For an incorrect published version, revert the relevant Git commit and push the
correction to the currently configured production branch `master` so continuous deployment builds the correction. A failed
Netlify deploy leaves the previously published version in place.
