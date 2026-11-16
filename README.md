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

## Netlify configuration

Use the recreated project `memberwebsocket-dev-netlify`
(`196e1d2c-8216-4ba8-aeb9-1706660adc2b`). The currently connected production branch is `master`. The `Integrated-Marketing-Platform` development branch uses a **native Netlify branch deploy**, published after exact-SHA CI succeeds, at `https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/platform/`. The GitHub release workflow validates the existing native deploy, reproduces its build artifact, verifies public files, CORS, and read-only Chromium E2E, and never uploads a competing branch ZIP. The production `master` deploy is unchanged.
Leave the base and package directories empty. The root `netlify.toml` sets:

- Build command: `node scripts/build-site.mjs`
- Publish directory: `dist`
- Node version: `24`

The project uses the existing Supabase project `dbuquirnaskrwcamdxki`.
The client config contains a public publishable key. Do not add a service-role key
or server secrets to frontend code or the publish directory.
`.netlify/` is ignored because linking writes local project state there.

## 正式與測試 `config.json` 完全獨立

請只修改所屬環境的完整 JSON。**兩個檔案都叫做 config.json，但路徑不同**；
部署時只會讀取對應檔案，沒有共用的環境設定值，也不依賴 Netlify
環境變數，或 GitHub 的特殊合併驅動程式。

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

## Backend origin allowlist

A live request from the target Netlify origin currently receives HTTP 403
`ORIGIN_NOT_ALLOWED`. Before enabling the new frontend, add the exact origin
`https://memberwebsocket-dev-netlify.netlify.app` to the Supabase Edge Function
`ALLOWED_ORIGINS` setting while preserving every existing allowed origin. Do not
replace the allowlist with `*`. Re-test preflight, unauthenticated rejection and
authorized application calls after the setting takes effect. This setting has not
been changed during preparation.

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

## Recovery

For an incorrect published version, revert the relevant Git commit and push the
correction to the currently configured production branch `master` so continuous deployment builds the correction. A failed
Netlify deploy leaves the previously published version in place.
