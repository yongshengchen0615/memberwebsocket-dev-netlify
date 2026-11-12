# 測試／正式環境隔離與合併防錯設計

狀態：設計稿，待核准；本文件不代表新站台或下列隔離措施已實作。

使用者已選擇「兩個獨立 Netlify 站台」。本輪既有資料庫分流與部署另外交付；新站台切換依本設計另行實作、測試及驗收。

## 1. 目標與不變條件

- 測試分支合併到 master，只帶入程式碼、測試及相容的遷移，不覆蓋正式環境設定。
- 正式站保留現有網址；測試站取得獨立網址、設定及部署身分。
- 缺少、混用或無法確認的必要部署設定，必須停止發布，禁止回退到正式專案。
- 測試環境無法使用正式部署憑證；測試 LINE 憑證不能通過正式後端的預期 Channel 驗證。
- 不複製正式會員、Auth、Storage 內容或正式外部服務秘密到測試環境。
- 使用成熟 LINE／Supabase 驗證機制，沿用現有角色與資源授權，不更換認證協定或自行發明加密。

非目標：新增會員功能、改寫業務規則、搬移正式資料庫、購買服務方案或電話號碼。

## 2. 已確認事實與缺口

- 正式 Supabase：MemberWebsocket-main，`dbuquirnaskrwcamdxki`。
- 測試 Supabase：MemberWebsocket-test，`bmwhojszsnxliekkhrka`；已有獨立 schema、canonical Edge Functions、private buckets、Vault key 及經核准的後端權限。
- 現有 Netlify 站台 ID：`196e1d2c-8216-4ba8-aeb9-1706660adc2b`；目前同時提供正式主網址及測試 branch alias。
- 現有 build 已依分支選擇 Supabase；完整產物會檢查專案、公開 key、API 與收據 CSP。
- 已實測兩邊 platform-api 都接受正式與測試來源。只改 ALLOWED_ORIGINS 秘密不足，入口程式還有共用的硬編碼來源清單。
- 前端目前沿用同一組 LIFF ID；後端 LINE Flex 訊息也有固定 LIFF 連結。完整隔離必須同時調整前端、預期 Channel 驗證與訊息連結。
- GitHub 發布工作目前共用 repository 層的 NETLIFY_AUTH_TOKEN，尚未達部署權限隔離。
- 三項測試 Twilio 欄位依先前要求建立空白占位；不得覆寫使用者後續填入的值，亦不得將正式值複製過來。
- 原生 Supabase GitHub schema／Edge 自動同步尚未啟用，歷史 migration 清單需先核對；本設計不直接啟用全面 db push。

## 3. 方案比較與已選方案

| 方案 | 效果與代價 | 決定 |
|---|---|---|
| 同一 Netlify 站台，分支 context 分流 | 網址不變，設定可分開，但站台與部署權限仍共用 | 不採作最終隔離方案 |
| 兩個 Netlify 站台，加獨立部署環境及設定契約 | 測試網址需變更，可獨立管理設定與部署能力 | 使用者已選擇 |

正式站沿用現有站台；只新增測試站。新測試站名稱由建立時確認可用性，建置者可選用清楚標示 test 的可用名稱，不購買新方案。

## 4. 唯一的環境對應契約

| 欄位 | 正式 | 測試 |
|---|---|---|
| APP_ENV | production | testing |
| Git 分支 | master | Integrated-Marketing-Platform |
| Netlify Site ID | 現有正式站 ID | 新建測試站 ID，未取得前禁止啟用發布 |
| Supabase ref | dbuquirnaskrwcamdxki | bmwhojszsnxliekkhrka |
| GitHub Environment | production | testing |
| LINE／LIFF／Webhook | 正式專用 | 測試專用，待建立 |
| Twilio | 現有正式資源 | 獨立測試子帳號、Verify Service 及 API Key |

**Netlify 的 production context 只代表該站台的主部署，不等於業務正式環境。** 新測試站的主部署也可能是 production context。因此識別必須同時驗證 APP_ENV、Site ID、分支與 Supabase ref，不能再單獨因 Integrated + production context 就拒絕，也不能單靠 context 選擇正式資料庫。

未知站台、未知環境、錯誤大小寫、錯誤分支或互相衝突的組合一律停止建置／部署。

## 5. 設定保存與合併規則

1. 程式碼維持一份；兩邊使用相同設定名稱及格式，環境相關的值各自保存。
2. Netlify／GitHub 各自環境保存前端公開設定與部署設定；Supabase 各專案保存後端秘密。
3. SUPABASE_URL、DB_URL、service role／secret key 沿用各專案系統值，不跨專案複製，不放進前端 bundle。
4. Git 只保存設定 schema、公開的允許對應及範例空值；不把 .env、密鑰、正式環境設定快照合併到測試分支。
5. netlify.toml 保留共用建置／路由規則，不寫環境專屬的後端、憑證或 LINE 值。Netlify 檔案設定可覆蓋 UI 設定，CI 必須攔下這類重複定義。
6. 所有公開連線與 LIFF 設定由目標環境注入建置產物。既有 source config 的正式值不得成為缺值時的隱含 fallback；舊入口相容性須先盤點再移除。
7. 設定契約檢查必填、型別、URL、專案 ref、公開 key 類型與預期 LINE Channel；日誌只輸出欄位名稱、公開識別與是否就緒，不輸出秘密。
8. Twilio 空白占位允許保留測試站其他功能，但電話驗證維持 fail closed、不可略過。有效憑證與測試門號就緒前，OTP 不列為通過。

## 6. 登入、來源與外部副作用

### LINE 與回跳

- 建立測試專用 LINE Login／Messaging Channel／OA 與 LIFF；Endpoint 指向新測試站。
- 正式後端只驗證其核定 Channel；測試後端只驗證測試 Channel。預期 audience 來自伺服器可信設定，不能由用戶輸入自行指定。
- 前端 LIFF、伺服器預期 Channel、LINE Flex 按鈕連結與 webhook 驗簽秘密必須一起對應環境。
- 測試管理員／會員只在測試資料庫建立，不複製正式角色資料；初始管理權限依既有核准流程由操作者明確設定。
- 若將來啟用 Supabase Auth，也分開 Site URL／redirect allowlist／SMTP；目前不假設它已作為主要登入方式。

### 來源白名單

- Edge API 使用該環境核定的 ALLOWED_ORIGINS，不再加入兩邊共用的硬編碼分支清單。
- 測試站切換期間可暫時接受「舊測試 alias + 新測試網址」，驗收後移除舊 alias。
- 正式入口盤點包含現有主網址、GitHub Pages、develop/platform 等歷史入口。未知用途的既有正式來源不得直接刪除；先確認仍需保留或安排同路徑轉址。
- CORS 限制瀏覽器來源；真正授權仍由有效 token、預期 Channel、後端角色、資源歸屬及 RLS 驗證。通用 Data API 不以 CORS 代替存取控制。

### Twilio、排程與通知

- 測試使用自己的 Verify Service／API Key，建議置於獨立測試子帳號；子帳號仍可能共用主帳號計費，不宣稱財務帳戶完全分離。
- 測試預設禁止對真實客戶發送 LINE／SMS／Email；需要實測時只允許核定測試收件人。
- 防止副作用的開關與收件人限制由後端執行，不能由前端參數解除。
- 排程、webhook、通知佇列、Storage 與日誌各自對應專案；不得匯入正式會員作測試。

## 7. 部署權限與自動發布

- GitHub production Environment 僅允許 master；testing Environment 僅允許核定測試分支。PR／fork 不取得正式部署秘密。
- 使用不同的環境秘密名稱，例如 NETLIFY_PRODUCTION_DEPLOY_TOKEN 與 NETLIFY_TEST_DEPLOY_TOKEN，避免環境秘密缺值時回退至同名 repository secret。
- 先配置、驗證新身分再切換工作流程；兩邊成功後撤除共用 repository NETLIFY_AUTH_TOKEN。既有秘密無法讀出時，由操作者在平台重新設定，不要求貼到對話。
- 測試部署身分必須沒有正式站部署權限。兩站台本身不保證 token 權限分開；必須核對 Netlify 實際身分與權限，必要時使用受限團隊／部署帳號。未確認前不宣稱權限完全隔離。
- 不用對正式站的實際寫入嘗試來測試 token 是否受限；以供應商權限資料及隔離工作流程取證。
- 保留既有自動部署目標：合併 master 後，只要同 SHA 必要 CI 全成功即可自動發布，不額外增加日常人工核准步驟。
- 部署只使用通過驗證的同 SHA 產物；發布前確認 branch HEAD 沒改變、Site ID 正確、產物環境正確。建置後產生不含秘密的版本／環境 manifest。
- 兩個站台的日常發布彼此獨立；切換驗收期間確認正式站未被測試發布改動，之後以各自 Site ID 與部署權限作主要邊界。

## 8. 資料庫與 Edge 版本

- migration／Edge 原始碼可以合併；資料、秘密、專案設定與執行中的排程不隨 Git 合併複製。
- 先核對現有 migration history，再規劃增量遷移；不直接啟用全面 db push／reset 或 blanket Edge deploy。
- 測試驗證全新遷移、既有版本升級、交易與回復；正式採相容的擴充／收斂順序，避免舊前端立即失效。
- 不增加 reset／purge RPC、管理員主表寫入或稽核刪除權限來解決部署問題。
- 涉及不可逆正式資料處理、付費服務或新增安全敏感存取，依實際變更另行取得必要授權。

## 9. 切換順序與回復

1. 保留目前兩個已驗證 deploy、branch SHA、設定名稱與來源白名單清單；不讀出秘密值。
2. 建立新測試站，但先不切換現行入口；取得實際 Site ID／網址，配置測試專屬 LINE／Twilio 與部署身分。
3. 準備 production/testing GitHub Environments、分支限制與新秘密；未配置完整前，既有正式發布維持運作。
4. 在獨立 PR 實作環境契約、Site ID 識別、注入設定、CORS／LINE 對應及 CI 負向檢查；先在新測試站完整驗證。
5. 用相同程式碼在正式設定建置，檢查只出現正式後端／登入回跳；必要 CI 成功後發布，正式網址不變。
6. 核對新測試站、正式站、webhook、實際 LINE／OTP、儲存與資料結果。外部憑證或測試收件人未就緒者，標示未執行，不能算完整隔離驗收成功。
7. 舊測試 alias 完成轉址或停止使用，收斂白名單，撤除共用部署秘密；保留回復點。

回復以各站前一個已驗證產物或 fix-forward PR 為單位。測試站回復仍必須指向 test，禁止為了恢復可用性改連 main。正式資料庫回復依遷移相容性及備份方案處理，不對正式會員作 reset。

## 10. 驗收與測試計畫（全部待本設計實作後執行）

| AC | Given／When／Then | 層級與證據 |
|---|---|---|
| AC-001 | Given 同一程式碼，When 在兩個目標建置，Then Supabase／LIFF／CSP／環境標示皆符合目標 | 單元、完整產物掃描、線上 config 與版本 |
| AC-002 | Given 缺值、未知站台、錯誤分支或混合設定，When 建置／發布，Then停止且沒有上傳 | 單元、工作流程負向案例 |
| AC-003 | Given 測試設定檔被帶進 PR，When合併master，Then CI攔截覆蓋或正式建置仍只取核定正式設定 | 合併契約測試、產物驗證 |
| AC-004 | Given 新測試站的Netlify production context，Then仍使用testing；正式站只接受production對應 | Site／branch／APP_ENV四元組測試 |
| AC-005 | Given 測試來源／正式來源跨環境呼叫Edge API，Then不允許該來源且不執行業務動作 | 真實HTTP負向、資料斷言 |
| AC-006 | Given 測試LINE token／錯誤Channel／舊憑證，When呼叫正式受保護API，Then後端拒絕 | 驗證單元、隔離整合、核可真實LINE測試 |
| AC-007 | Given 測試通知／排程／Webhook，Then僅使用測試資源與核定收件人，正式資料無變更 | stub故障、實際沙盒、前後資料核對 |
| AC-008 | Given 測試工作／PR／fork，Then拿不到正式部署秘密，部署身分無正式站權限 | GitHub規則與Netlify權限取證 |
| AC-009 | Given test的Twilio空白，Then電話驗證不可用且不略過；有效測試憑證就緒後另驗證OTP | 正常／缺值／失敗／沙盒案例 |
| AC-010 | Given 必要CI失敗、跳過、取消、未觸發或HEAD改變，Then不得發布 | 同SHA工作流程與發布測試 |
| AC-011 | Given 遷移或Edge更新，Then新建／升級／回復、授權、交易與跨帳號負向皆成功 | 既有Postgres／Edge／完整產品CI |
| AC-012 | Given 任一站回復，Then另一站與其資料不變，測試後端不回退main | 回復演練、版本與資料證據 |

每次程式／設定交付仍執行既有完整基線、所有新增案例、正式模式建置、依賴檢查與部署後冒煙。以上是測試計畫，並非已通過的測試結果。

## 11. 執行前須確認／提供的項目

- 最終正式來源清單：GitHub Pages及develop/platform歷史入口哪些仍在使用，哪些可以轉址或退役。
- 新測試 LINE／LIFF／OA、Webhook 驗簽資料及核定測試帳號／收件人；機密只填平台秘密管理。
- 權限確實受限的測試部署身分及兩個GitHub Environment秘密；建置者不得自行共用正式token替代。
- 實際新測試站名稱／網址／Site ID於建立時取得，不能用預測值宣稱已建立。

上述依賴未就緒時，可以完成程式碼與隔離測試，但不得宣稱外部服務或完整隔離已驗證完成。

## 12. 官方參考

- [Netlify 環境變數、context與覆蓋順序](https://docs.netlify.com/build/environment-variables/overview/)
- [GitHub Environment分支限制與秘密](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [LINE LIFF Endpoint設定](https://developers.line.biz/en/docs/liff/registering-liff-apps/)
- [LINE伺服器驗證token與預期Channel](https://developers.line.biz/en/tips/2026/08/13/send-token-to-server/)
- [Twilio子帳號的資源、憑證與計費邊界](https://www.twilio.com/docs/iam/api/subaccounts)
- [Supabase Auth回跳設定](https://supabase.com/docs/guides/auth/redirect-urls)
