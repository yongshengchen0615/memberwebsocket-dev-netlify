# QA 與完成列表 E2E 盤點 — 2026-10-09

範圍：會員系統 Trello 的 QA **11 張**、完成 **33 張**，合計 **44 張**。核對所有卡片說明及 checklist，程式基準為 `8e26e1ab609e4c5471520e73d19da65db244cd46`。本表區分案例存在、隔離測試與部署後驗收；列表名稱不代表驗收通過。

## 主要結論

- QA 有 134 項 checklist，其中 50 項未完成；完成列表有 275 項，其中 33 項未完成，分布於 9 張卡片。歷史規格／拆分卡有重複驗收，不能直接加總為功能缺陷數。
- 真正缺少 runtime 入口的是服務項目發放、設定複製拒絕入口、會員編號複製、好友／優惠 QR 與轉贈好友／QR 收件者。本次新增 5 個節點並接進模組篩選、依賴圖與完整模式。完整模式 63 種管理模組組合與 5 個用戶端均具案例檢查；功能目錄由 50 增至 55 項。
- 設定複製、會員移除、階級可見性、無障礙審核已存在隔離 Chromium／SQL 測試。這些是證據層級或線上實跑缺口，不應重新標成完全未測。
- 邀請獎勵的 paired 測試仍期待「雙方獲券、來源 ID 即領取 ID、未預約也可用」；目前程式採輸入者獲券、每次發行新子券、票券可用性另依預約資格。本次增加正式 PostgreSQL migration 驗證，並改為驗證輸入者持有、同 request 去重、再次邀請新會員、被邀者不獲本次獎勵。清理失敗不能回報通過。
- 名冊上的「狀態／發放」已移到會員 360，舊 runtime 共用 helper 尋找已移除按鈕。本次修正路徑、等待前次載入完成，並以 lineUserId／完整會員編號核對指定會員。
- 覆蓋聚合保留同一節點最弱證據：blocked／skipped／cancelled／running 不能被後續 passed 蓋掉；failed 仍優先。

## 本次整合

| 案例 | 驗證內容 | 證據與限制 |
|---|---|---|
| `ADMIN_SERVICE_GRANT_JOURNEY` | 本輪專用測試會員、空選項拒絕、服務預覽、雙擊送出、服務時間回讀、清理 | runtime 操作 UI；沒有 LINE／正式用戶寫入；SQL 另驗證點數帳本 |
| `ADMIN_SETTINGS_COPY_CONTROLS` | 三類未保存設定拒絕複製與關閉 | 不建立複本；既有 Chromium／SQL 負責草稿及獨立 IDs |
| `MEMBER_CODE_COPY` | 點擊、成功／失敗回饋與按鈕恢復 | DOM 執行正式 handler；原生剪貼簿另由 Chromium |
| `MEMBER_QR_CONTROLS` | 好友／優惠分頁入口、外站碼拒絕、共用 dialog | 不請求相機、不建立邀請；缺 parser 必須失敗 |
| `POINTS_TRANSFER_RECIPIENT_CONTROLS` | 已接受好友載入、手動／QR 替代入口、取消 | 不扣點；無餘額或待確認交易明確 skipped，好友載入失敗為 failed |

新增服務發放 SQL 以正式 migration 與 PostgreSQL snapshot 驗證 62 分鐘／2 點、冪等、request 衝突、數量與服務驗證、預覽失效、權限及已寫兩種帳本後故障的整筆回滾。新增轉贈 Chromium 案例覆蓋好友成功、QR PNG 只查詢不自動扣點、手動重送、好友載入失敗、自轉拒絕與晚到相機停止。管理端未知寫入結果依正式介面鎖定直到重載，不使用測試直接跳過鎖定。

## 證據判讀

- **runtime**：部署頁面上的 E2E 節點存在且進入完整模式；不代表已在線上執行。
- **DOM**：正式介面 handler 與隔離 transport；不驗證真實版面、剪貼簿或影格。
- **Chromium 案例**：Playwright 執行正式 UI，transport 隔離；不能認證 Supabase／LINE 正式投遞。
- **SQL**：正式 snapshot／migration 的 PostgreSQL 行為；單一 PGlite 連線不能認證真正兩連線併發。
- **實機／線上**：LINE／LIFF、GPS、相機裝置、Auth／Storage 跨服務失敗及真實 Realtime 需要獨立證據。

Supabase dev 只做 metadata 及 automation 表的彙總唯讀查詢；本次查詢時 runs／cases 均為 0。此為「目前沒有可回讀的持久 run 證據」，不能推論從未執行，因可能已清理。本次未部署 Edge Function、未改 schema、未清理線上資料。

## 44 張卡片對照

機器可檢查對照在 [`tests/trello-e2e-coverage.json`](tests/trello-e2e-coverage.json)。`runtimeFeatureIds` 連至 `e2e-feature-coverage.js` 的現行節點；測試檔存在與節點登錄由回歸檢查保護。對照不將一個 contract 案例當成整張卡片通過。

### QA

| 卡片 | 未勾選／總數 | 對應功能與證據 | 結論／仍缺部分 |
|---|---:|---|---|
| [[P1][E2E] 管理端功能覆蓋與無障礙預約審核](https://trello.com/c/rAnvrQp1) | 6／9 | `member.directory`, `booking.admin-lifecycle`, `booking.accessible-admin`<br>`admin-human.spec.cjs` | 現有完整管理流程；本次修正會員 360 舊入口並加服務發放。部署後六模組 run code／清理證據仍待保存。 |
| [[管理端] 依服務項目登記並發放點數與服務時間](https://trello.com/c/WZ3vwIIM) | 3／13 | `member.service-grant`<br>`admin-human.spec.cjs`<br>`service_grant_sql.cjs` | 本次新增：空選項、數量、預覽失效、雙擊、catalog 失敗、寫入不確定鎖定／重載、SQL 回滾與重送。真實多連線及部署版本待驗。 |
| [[P1][預約票券] 使用資格、改約解除綁定與核銷一致性](https://trello.com/c/KOxWjquJ) | 3／8 | `tickets.service`, `booking.benefits`, `booking.lifecycle`<br>`booking_ticket_consistency.cjs`<br>`ticket_booking_choice.cjs`<br>`transaction_lifecycle.cjs` | 已有服務限制、綁定、改約／取消解除及核銷 SQL；兩個真實連線的 race、跨端狀態待驗。 |
| [[用戶端預約] 服務對象與好友操作 UI 優化](https://trello.com/c/Fg1e2Zgn) | 6／11 | `booking.group`<br>`member-p2.spec.cjs`<br>`friends_ui.cjs` | 已有好友／優惠分頁及代約 UI／SQL；服務對象 0／1／多位、切換保留資料與鍵盤流程仍需專項瀏覽器案例。 |
| [[P2][UI/UX] 全站排版整合、共用元件收斂與一致性優化](https://trello.com/c/BECc6lsi) | 0／21 | `shared.theme`<br>`ui-layout.spec.cjs`<br>`settings-layout.spec.cjs` | 已有隔離版面測試；不同裝置／LINE WebView 字體與縮放仍屬裝置驗收。 |
| [[用戶端] 預約活動票券沿用票券頁樣式](https://trello.com/c/WLz2BF3V) | 6／11 | `booking.benefits`, `event.crud`<br>`shared_event_ticket.cjs`<br>`ui-layout.spec.cjs` | 已有共用 renderer 與票券版面；指定卡片要求的完整載入／空／錯誤／鎖定／選取視覺矩陣尚未全部成為專項瀏覽器案例。 |
| [[管理端] 會員 360 子視窗返回與發放入口整理](https://trello.com/c/ddjFU4kK) | 3／11 | `member.directory`, `member.grant`, `member.service-grant`<br>`admin-human.spec.cjs` | 已有 360 子窗返回；本次修正 runtime 路徑並新增服務發放返回。每種子窗的焦點／Escape／背景關閉仍有待驗項目。 |
| [[P1][登入安全] 新登入成功後撤銷舊連線與強制登出通知](https://trello.com/c/6VyCnAnt) | 6／12 | `shared.session`, `member.revocation`<br>`login_session_sql.cjs`<br>`test_duplicate_login_sql.cjs`<br>`forced_logout_close.test.js` | SQL 撤銷與前端通知存在；兩個真實瀏覽器的新登入／舊 token 失效／Realtime 先後次序尚未實跑。 |
| [[P1][管理端] 移除會員全部資料與連線撤銷](https://trello.com/c/KqacPEVI) | 8／13 | `member.directory`<br>`admin-human.spec.cjs`<br>`member_removal_sql.cjs` | 已具移除確認、錯誤編號拒絕與資料庫移除測試；跨 Auth／Storage 故障補償及真實重登仍待驗，沒有專屬 runtime 移除節點。 |
| [[P2][UI/UX] QR 掃描與無障礙收據快照共用彈窗](https://trello.com/c/QLP54qAL) | 4／12 | `member.qr`, `booking.receipt`<br>`member-p2.spec.cjs`<br>`receipt-location.spec.cjs`<br>`points-transfer.spec.cjs`<br>`friend_qr_scanner.cjs` | 本次新增共用 QR 入口節點、轉贈 Escape／晚到相機停止；實機前後鏡頭、LINE 權限仍待驗。 |
| [[P2][點數轉贈] 好友選擇與 QR 收件者整合](https://trello.com/c/qaBhQ3XN) | 5／13 | `points.transfer`, `points.transfer-recipients`; `PAIRED_POINT_TRANSFER_ATOMIC`<br>`points-transfer.spec.cjs`<br>`qa_user_journeys.cjs` | 本次新增好友／QR／手動轉贈 UI、失敗恢復、雙擊與不確定重送。PNG／真實瀏覽器待 CI；線上多連線守恆待驗。 |

### 完成

| 卡片 | 未勾選／總數 | 對應功能與證據 | 結論／仍缺部分 |
|---|---:|---|---|
| [[預約設定] 工作時段、切分間隔與跨夜營業可設定](https://trello.com/c/yw0nT1O7) | 0／8 | `booking.settings`<br>`admin-human.spec.cjs`<br>`booking_sql.cjs` | 已有設定保存、跨夜 SQL；夏令／跨日提醒的實際排程與部署環境待驗。 |
| [[會員申請/法務] 管理員維護條款，申請會員時強制同意](https://trello.com/c/LhP0mklc) | 0／9 | `member.terms`<br>`member-join-terms.spec.cjs`<br>`admin_terms.cjs`<br>`member_terms_startup.cjs` | 已有未勾選拒絕、目前條款版本與成功申請；正式條款改版後跨端同步需線上 run。 |
| [[UX] 所有用戶端每次開啟教學與今日略過](https://trello.com/c/qsTxEQzY) | 0／13 | `shared.tour`<br>`member_first_use_tour.cjs`<br>`member-p2.spec.cjs` | 歷史「每次／今日略過」需求已被 SDdOuOeS 的首次教學與明確不再顯示取代；以現行規則測試。 |
| [[預約通知] LINE 顯示可用票券與活動](https://trello.com/c/VtDiHS1A) | 0／10 | `booking.settings`, `booking.benefits`<br>`booking_settings_notification_sql.cjs`<br>`notification_entitlement_behavior.test.js` | 通知內容及權益快照有程式／SQL 證據；LINE 官方帳號實際投遞、點擊跳轉待驗。 |
| [[P1][企劃][會員安全] 強制下線與維護管制：需求、規則與驗收](https://trello.com/c/SRiRn2uN) | 0／12 | `member.revocation`<br>`forced_logout_close.test.js`<br>`admin-human.spec.cjs` | 企劃來源卡；與 BzcIsJTk 共用驗收，不能把規格文件當成 runtime 通過。 |
| [[P1][設計][會員安全] 強制下線與維護管制：管理端與會員端 UI／UX](https://trello.com/c/NeBybbEx) | 0／12 | `member.revocation`<br>`forced_logout_close.test.js`<br>`admin-human.spec.cjs` | 設計來源卡；管理入口與退出路徑有測試，裝置通知顯示仍需線上驗收。 |
| [[P1][程式][會員安全] 強制下線與維護管制：後端、前端與安全 E2E](https://trello.com/c/bz5K49k0) | 0／17 | `member.revocation`, `shared.session`<br>`login_session_sql.cjs`<br>`admin-human.spec.cjs` | 已覆蓋權限／單次下線管理操作；離線舊 session、HTTP／Realtime 競態與維護解除需真實雙端。 |
| [[P1][活動票券] 顯示會員今日可使用張數](https://trello.com/c/tAk3xIlB) | 0／13 | `event.limits`<br>`qa_event_day_sql.cjs`<br>`e2e_feature_nodes.cjs` | 每日額度與 badge 回讀已有；午夜／時區跨日與即時更新的線上長流程待驗。 |
| [[P2][會員成長] 邀請碼綁定與雙方優惠券獎勵](https://trello.com/c/JAu9THfd) | 0／15 | `member.referral`; `PAIRED_MEMBER_REFERRAL_REWARD`<br>`e2e_referral_current_rule.test.js`<br>`referral_inviter_only_reward.test.js`<br>`referral_current_rule_sql.cjs`<br>`member-p2.spec.cjs` | 卡名「雙方」為舊規則；現行輸入者一張，重送同一邀請不重發、另次邀請可再發。本次修正 paired 子券 ID／領取狀態判斷及清理失敗。 |
| [[P2][集點卡] 會員點數轉贈與原子交易保護](https://trello.com/c/S6cyhQub) | 0／15 | `points.transfer`, `points.transfer-recipients`; `PAIRED_POINT_TRANSFER_ATOMIC`<br>`points-transfer.spec.cjs`<br>`transaction_lifecycle.cjs` | 既有原子 SQL／paired API；本次加入真正 UI 操作。真實兩連線同時扣點尚待線上驗收。 |
| [[活動優惠券] 限量領取、每人限用與定位核銷](https://trello.com/c/S2iqRat9) | 1／8 | `event.crud`, `tickets.location`; `PAIRED_EVENT_LAST_TICKET_RACE`<br>`event_coupon_sql.cjs`<br>`receipt-location.spec.cjs` | 已具限量／定位與最後一張 paired 案例；隔離 SQL 不能取代實際兩連線 race／GPS 精度驗收。 |
| [[E2E] 六模組完整流程與逾時復原驗收](https://trello.com/c/hJ7KHBcV) | 1／7 | `testing.accounts`, `shared.session`<br>`e2e_complete_feature_coverage.test.js`<br>`e2e-refresh.spec.cjs`<br>`qa_cleanup_boundaries.cjs` | 歷史六模組完成卡仍留 1 項實跑證據；本次新增 5 個 runtime 節點、55 功能對照與弱證據保留，不宣告 live 全通過。 |
| [[P1][會員安全][協作總卡] 強制會員下線與維護期間存取管制](https://trello.com/c/BzcIsJTk) | 23／23 | `member.revocation`, `shared.session`<br>`login_session_sql.cjs`<br>`forced_logout_close.test.js`<br>`admin-human.spec.cjs` | 23 項 checklist 仍未勾選，與拆分企劃／設計／程式卡重複；需以共同線上雙端證據逐項關閉。 |
| [[預約提醒] 前一天提醒時間可設定](https://trello.com/c/8kxtOrHq) | 1／8 | `booking.settings`, `automation.health`<br>`booking_settings_notification_sql.cjs`<br>`booking_notification_dispatch_schedule.test.js` | 設定、佇列及排程邏輯已有；指定時間投遞、重試與實際 LINE 收件仍待驗。 |
| [[P1][預約核對] 完成預約拍攝收據與管理端快照檢視](https://trello.com/c/t9HzzKQL) | 1／16 | `booking.receipt`, `booking.accessible-admin`<br>`receipt-location.spec.cjs`<br>`admin-human.spec.cjs`<br>`receipt_integrity_sql.cjs` | 已有 fake camera／快照／簽章完整性；實體裝置與跨服務上傳失敗補償待驗。 |
| [[預約] 頁首顯示可用活動與票券](https://trello.com/c/kJExuw1n) | 1／8 | `booking.benefits`<br>`booking_benefits.cjs`<br>`shared_event_ticket.cjs` | 已有可用權益 renderer；0／1／多筆及斷線後 Realtime 恢復尚需完整瀏覽器矩陣。 |
| [[P2][會員導流] 註冊成功後由用戶傳訊至 LINE 官方帳號](https://trello.com/c/SaQR21KH) | 1／14 | `member.join`<br>`membership_join_test_account.test.js`<br>`member-join-terms.spec.cjs` | 有加入成功與測試帳號隔離／訊息 payload；LIFF 實際開聊天室／傳訊與重送回饋需 LINE 實機。 |
| [[預約][票券核銷] 預約頁顯示可用活動／票券，完成服務時自動核銷](https://trello.com/c/GqJwHJ51) | 1／24 | `booking.benefits`, `booking.admin-lifecycle`<br>`transaction_lifecycle.cjs`<br>`booking_ticket_consistency.cjs` | 已覆蓋完成服務時核銷及回滾；正式 LINE 通知與跨端同步仍保留 UAT。 |
| [用戶端 會員電話格式需要正確](https://trello.com/c/6GkXwA2G) | 0／0 | `member.phone`, `member.profile`<br>`member_terms_startup.cjs`<br>`test_account_phone_sql.cjs`<br>`e2e_feature_nodes.cjs` | 已有台灣國碼、重複數字／無效輸入與保存回讀；若擴充其他國家規則需新增對應案例。 |
| [完成預約時會傳 等待管理員確認預約 到官方帳號聊天視窗](https://trello.com/c/0oENbEVe) | 0／0 | `booking.receipt`, `booking.admin-lifecycle`<br>`member_phone_and_pending_booking_notice.test.js`<br>`receipt-location.spec.cjs` | 待確認通知 payload／入口有測試；官方帳號聊天室實際顯示需 LINE 實機。 |
| [活動票卷 與集點卡票卷 可以設定 是否有預約什麼項目才能使用 例如 身體集點卡的優惠卷 只有 有預約身體相關服務才能使用](https://trello.com/c/Y5fs2XWy) | 0／0 | `tickets.service`<br>`ticket_booking_choice.cjs`<br>`booking_ticket_consistency.cjs` | 現行使用具體 service IDs 的 any／all 規則；測試覆蓋資格與結算，新增服務後需部署回歸。 |
| [用戶端預約 不需要過了預約時間才可上傳收據快照](https://trello.com/c/HAZz5IQU) | 0／0 | `booking.receipt`<br>`receipt-location.spec.cjs`<br>`receipt_integrity_sql.cjs` | 收據 prepare／上傳規則已有；不要求預約時間已過的線上完整提交流程待部署 run。 |
| [如果管理端 沒設定好友邀請票卷 則會無法使用好友邀請功能](https://trello.com/c/tRp809EW) | 0／0 | `member.referral`<br>`referral_member_identifier_behavior.test.js`<br>`referral_current_rule_sql.cjs`<br>`member-p2.spec.cjs` | 無有效獎勵來源時後端拒絕與 UI 提示已有；本次 paired 若已有來源會跳過，避免更動既有配額。 |
| [預約用戶端  加入 無障礙模式 可以方便長輩不會操作 直接上傳 收據快照 讓管理員登記完成的預約後 也會記錄點數與服務時間 且無障礙模式會直接顯示可用的票卷](https://trello.com/c/evsud1Xh) | 0／0 | `booking.accessible`, `booking.accessible-admin`<br>`booking_accessible.cjs`<br>`admin-human.spec.cjs` | 已有無障礙上傳與審核、票券點數結算、不確定重送；真實相機與部署版本待驗。 |
| [管理端與用戶端 預約紀錄 如果有 使用票卷 需要顯示是什麼集點卡的票卷 與活動票卷](https://trello.com/c/azCJknql) | 0／0 | `booking.sources`<br>`admin-human.spec.cjs`<br>`booking_copy.cjs`<br>`e2e_feature_nodes.cjs` | 已有會員／管理歷史來源 renderer 與已解除綁定說明；跨端 live 資料同步待驗。 |
| [[P2][管理端] 集點卡與兩類票券設定複製](https://trello.com/c/bGbmzpdP) | 0／6 | `tickets.copy`<br>`admin-human.spec.cjs`<br>`member_p2_features.cjs` | 原已有 card／ticket／event／fixed 草稿複製 UI＋SQL；本次補 runtime 未儲存拒絕入口，未宣稱新增整個複製能力。 |
| [[P2][教學] 預約與票券導覽、遮擋修正及不再顯示](https://trello.com/c/SDdOuOeS) | 0／7 | `shared.tour`<br>`member-p2.spec.cjs`<br>`member_first_use_tour.cjs` | 現行首次與不再顯示規則已有自動化；全部五端跨帳號偏好／LINE WebView 仍可擴充。 |
| [[P2][好友系統] 好友關係、邀請入口與代好友預約獎勵](https://trello.com/c/xp2aIRkQ) | 0／8 | `member.referral`, `booking.group`<br>`member-p2.spec.cjs`<br>`friends_ui.cjs`<br>`member_p2_features.cjs` | 好友同意、封鎖／移除、代約授權與完成加贈 SQL 已有；代約成功／取消／移除好友後的完整瀏覽器生命週期仍待專項。 |
| [[P2][活動票券] 會員階級可見性、鎖定提示與日曆顯示規則](https://trello.com/c/mzBhSgbg) | 0／5 | `event.crud`, `calendar.member`<br>`admin-human.spec.cjs`<br>`shared_event_ticket.cjs` | 階級可見設定與 SQL／renderer 已有；四類階級跨 event／booking／calendar 的整體矩陣可再補。 |
| [會員卡 會員編號旁邊 加入一個 複製按鈕](https://trello.com/c/KYbD8eDI) | 0／0 | `member.clipboard`<br>`member-join-terms.spec.cjs`<br>`qa_user_journeys.cjs` | 本次新增 runtime 成功／失敗回饋、DOM 真實 copy handler、原生剪貼簿內容檢查；Chromium 執行待 CI。 |
| [[P1][預約設定] 是否必須預約主要技師才能預約](https://trello.com/c/yCOGcGUz) | 0／6 | `booking.settings`<br>`admin-human.spec.cjs`<br>`booking_primary_requirement_behavior.test.js` | 設定保存與主要技師邊界已有；多參與者的真實用戶提交／切換快取可再擴充。 |
| [[P2][預約體驗] 首次一般模式與記住切換偏好](https://trello.com/c/9sE85D48) | 0／5 | `booking.accessible`<br>`booking-mode.spec.cjs`<br>`booking_accessible.cjs` | 首次一般與按會員記住偏好已有；既有舊 key 遷移及無儲存權限可再擴充。 |
| [[P1][活動票券] LINE 通知時間與停用設定](https://trello.com/c/GcZdmaQz) | 3／6 | `event.fixed`, `automation.health`<br>`admin-human.spec.cjs`<br>`fixed_ticket_automation_sql.cjs`<br>`booking_settings_notification_sql.cjs` | 設定 UI、排程及停用條件已有；3 個待驗 checklist 需真實發券／通知時間／停用無收件證據。 |

## 後續驗收優先順序

1. **P1 線上雙端**：新登入撤銷舊線、票券改約／核銷與最後一張競爭、同時轉贈、服務發放併發。使用專用測試帳號與明確 request IDs，保存兩端終態及 run code。
2. **P1 跨服務**：會員移除的 Auth／Storage 失敗補償、收據上傳中斷及重送。現有 SQL 無法代表跨服務都完成。
3. **P2 瀏覽器矩陣**：服務對象 0／1／多位、切換保留輸入、好友代約完整生命週期、四類階級可見與票券空／錯誤／鎖定狀態。按差異補專項案例。
4. **P2 外部與裝置**：LINE 收件／LIFF 開聊天室、指定時間通知與停用、實機相機／GPS／WebView。保留 checklist 未勾選，待實測證據關閉。

歷史「雙方邀請獎勵」與「每次教學／今日略過」以現行程式及較新需求取代；原卡可附此對照，避免新增錯誤期望。安全企劃、設計、程式及總卡共用驗收，不重複計為四套 E2E。

## 原生瀏覽器發現與修正

首輪 Chromium 161 項通過、6 項轉贈入口案例失敗；所有失敗均指出正式集點卡 `::before` 裝飾層攔截點擊。修正正式 CSS 裝飾層的 `pointer-events`，由原本真人點擊案例驗證；不使用強制點擊跳過 actionability。轉贈 fixture 同時補齊集點卡樣式與顯示資料。

PR 審查另確認會員狀態／個資／發放通知 runner 關閉子視窗後，可能留下會員 360 遮罩。本次在案例 `finally` 依序透過正式按鈕關閉子窗與父窗，關閉失敗回報 cleanup error；新增個資還原、通知模式及 360 載入失敗驗證，所有路徑均檢查沒有殘留視窗。

CI 首輪也同時跑 push／PR 兩套測試，因 branch group 使用不同的 ref 格式；本次統一來源 repository 與 branch 名稱，保留新推送取消舊 run，避免重複執行。

## 本輪驗證狀態

- 692 項 JavaScript 回歸通過（含邀請規則行為與 44 卡矩陣檢查）。
- 完整管理端 DOM 113 項通過；另新增會員 360 runtime、個資還原、通知模式及載入失敗案例並重驗服務發放，共 117 項具通過證據（含父測試）。新增用戶 DOM 5 項通過。
- 服務發放 PostgreSQL 5 項通過（含父測試）；32 個整合測試檔共 179 項通過（含父測試；31 檔完整驗證 174 項，加新增邀請 SQL 5 項），覆蓋條款、收據、票券一致性、登入、移除、排程與本次用戶流程。
- Playwright 可成功列出全部 170 個案例；原生 Chromium 在本機啟動即 `SIGTRAP`，沒有進入應用程式，狀態為環境阻擋，不能記作功能測試通過。新增 Playwright 案例需 GitHub Actions 原生 Chromium 執行。
- 後續已獲授權推送與合併至 main，變更已發布至 [PR #314](https://github.com/yongshengchen0615/yongshengchen0615.github.io/pull/314)。CI 執行回歸、DOM／SQL、原生 Chromium、語法、Edge Function 型別與架構檢查；以該 PR 最新版本的結果為準。

