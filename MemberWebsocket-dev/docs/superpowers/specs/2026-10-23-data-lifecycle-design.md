# #82 資料生命週期：CLR-01 現況清冊與安全設計審查稿

本稿交付唯讀盤點、隔離重現與待審設計，不交付清除功能。未取得資料處置政策及獨立沙盒前，不新增清除 API、按鈕、GRANT、CASCADE 或破壞性 migration。

## 第一性原理與證據界線

| 面向 | 已確認事實／約束 |
|---|---|
| 目標 | 區分平台重置、單一商家刪除、單一帳號刪除、合成測試資料清理，避免一個指令混用四種範圍 |
| 身分與權限 | 現有兩個 maintenance 函式為 SECURITY INVOKER；遠端 anon/authenticated/service_role 的 EXECUTE 均為 false。資料庫操作人權限不等於產品 root 權限 |
| 狀態 | 現有成功路徑會停用 super_admins，但這不證明 Auth、LINE、會員工作階段或外部副本已撤銷 |
| 資料 | 清除的最小單位必須包含依賴關係、憑證、佇列、物件與稽核的個別處置；不能只計算刪除筆數 |
| 限制 | #82 是設計安全閘；#48 尚未指定可重設會員沙盒。本輪既有 Supabase 僅執行系統目錄 SELECT，沒有讀會員／憑證資料列或呼叫 maintenance |
| 驗收 | 每項範圍與保存例外有負責人、可重現清冊和還原證據；未確認項維持阻擋，不能宣稱全卡完成 |

固定來源：`Integrated-Marketing-Platform@d0906c7a801bf64ed89cfb07172c40a114e345eb`。
遠端系統目錄時間：2026-10-23 13:45:33／13:46:11（Asia/Taipei）。Project：`MemberWebsocket-dev`，ref `dbuquirnaskrwcamdxki`。

## 實際清冊與現有清除行為

以下是目前程式／目錄的觀察，並非已批准的刪除政策；「不在範圍」不代表對外部相依完全沒有間接影響。

| 資產 | 現有行為／相依 | 本設計的處置提案／待決事項 |
|---|---|---|
| public：62 表、62 啟用 RLS | clear_public_data 選 public 與 booking_notifications，排除 public.admins；因此目前選中 63 表（61+2），成功後重建必要系統基線 | 將使用者資料、系統必要值、稽核分開列；不得以表名或全 schema 通配取代批准的 allowlist |
| public.admins | 明確保留；platform_private.super_admins 有 ON DELETE RESTRICT 外鍵指向它 | 「刪除所有管理員」與現況不符。最後 root／復原操作人政策必須先決策 |
| public.audit_logs／booking_audit_events | 會進入 public 清除集合 | 保存期限、匿名化欄位與最小安全證據由資料責任人核可；預設不得隨業務資料一起抹除 |
| platform_private：9 表、9 啟用 RLS | remove_all_data 明列 applications、tenant_secrets、audit_events、requests、tenants 五表；super_admins 只設 enabled=false | 將申請、商家、冪等記錄、憑證、稽核、root 各列不同處置；尚無批准政策 |
| module_secrets／module_notification_routes | 兩表外鍵都指向 tenants、ON DELETE RESTRICT，未列入舊 TRUNCATE；即使空表也會阻擋 tenant TRUNCATE | 確認為現有相容性缺口；不得直接加 CASCADE 或移除 FK「修通」清除 |
| business_templates | 不在舊五表清除清單 | 版本模板可能是重建所需資產，與商家實際資料分開保存／版本化 |
| 商家 business_*：本次可見 1 個 schema、69 表全啟用 RLS | 舊 maintenance 清單不直接選取 business_*；先前文件 64 表是歷史模板快照 | 商家刪除需以 tenant→runtime_schema 的伺服器歸屬核對，不使用使用者傳入 schema。重建／升級與 #53 共用基線 |
| booking_notifications：2 表、2 啟用 RLS | config/outbox 進入舊 public 清除集合；商家另有通知佇列 | 先停發、記錄最後游標與事件去重；還原時不得重播歷史訊息，與 #52 共用驗收 |
| auth：27 表／storage：8 表 | 沒有被舊函式直接列入；本輪未查任何帳號或物件內容 | Auth 撤銷／刪除須走支援的管理介面；Storage 物件和 DB metadata 必須分開核對，不直接刪 storage 系統表 |
| line_config：2 表 | 不在舊函式直接範圍；本輪不讀任何 secret 值 | 保存／輪替與商家模組憑證、外部 Channel 撤銷分別決策，報表僅用 credential version/reference |
| cron/net/realtime／vault／環境變數 | 不在 remove_all_data 明列清除範圍；這不證明 worker 已停止或既有請求可撤回 | 核對排程與 worker lease、外發封鎖、快取失效及 vault 引用；不將秘密放入清冊 |
| 備份／PITR／外部 LINE 訊息／部署與日誌 | SQL TRUNCATE 不會一併處置；本輪未驗備份涵蓋率、物件 checksum 或 Provider 刪除能力 | 另列保存責任、失效／刪除時程、不可撤回副本與還原演練，不承諾 SQL 可以撤回已送訊息 |

RLS 啟用數量只是目錄資訊，不等於各 RPC／service role／tenant 存取已通過安全驗收。

### 兩個新增外鍵的重現與回滾

來源：

- `supabase/migrations/20261018182000_remove_all_business_data.sql`
- `supabase/migrations/20261019122917_module_line_scope.sql`
- `supabase/migrations/20261020140336_module_notification_routes.sql`
- `supabase/migrations/20261001221500_restore_event_ticket_settings_baseline.sql`

遠端 `pg_constraint` 確認兩個 module 子表各有 tenant FK。隔離 PGlite 測試執行原 remove_all_data body，以及從真實 migration 擷取的各子表 CREATE TABLE；只將 clear_public_data 縮成與原 AC-022 相同的 public.members 階段。

四個案例為兩張子表各自的空表／有合成資料。觀察結果均須為 SQLSTATE `0A000`，public.members、admins、五張平台表仍各有原始一筆，子表保持原數量、root enabled 仍為 true。這確認函式錯誤回滾邊界，**不是**全 schema 清除、Auth 撤銷、外部系統一致性或真實遠端破壞性測試。

測試刻意固定「拒絕且回滾」；後續改為有範圍的清除須在獨立實作卡先核可新契約，再更新此特徵測試。不能把這組測試的綠燈寫成「清除功能修復」。

## 方案比較與建議（尚待審查）

| 方案 | 成本／影響 | 判斷 |
|---|---|---|
| 擴大舊全域 TRUNCATE／CASCADE | 初期程式少，但會擴大 FK 清除範圍，仍涵蓋不到 Auth、物件、備份及外部通知 | 不採用；與 #82 的安全設計閘及未核可保存政策衝突 |
| 分成四種操作，共用明確範圍 manifest、權限與復原閘 | 需逐資產建模，但範圍可讀回、可測試、可停止；沿用既有會員刪除／QA 清理流程 | 建議後續方向；本 PR 僅提出設計，不新增執行器 |

### CLR-02：授權與 dry-run 提案

1. 請求固定 operation、environment/project、tenant/resource allowlist、操作者及版本；伺服器驗證目前身分與授權。會員不能透過此流程改角色或刪別人的資料。
2. dry-run 只讀，列資產類型、預估筆數、受影響相依、保留理由、備份引用與計畫摘要雜湊；不輸出 LINE UID、token、secret 或密文內容。估計筆數與一致快照精確筆數必須明示差異。
3. 執行前重新驗證身分／授權與資料版本；計畫過期、變更、跨商家、未備份或無還原證據均拒絕。Production 另需個別授權與不同人的覆核，不能把確認字串當二次驗證。
4. 停止相關 worker/outbox；未進不可逆階段可取消。進入外部物件刪除後使用可追蹤狀態機／補償作業，不能承諾跨 DB、Storage、Provider 的單一原子交易。
5. 同一 operation/request ID 僅一次執行；重試不得重複外發。最小安全稽核留在此操作無權刪除的保存邊界，成功與失敗都記錄操作者引用、範圍摘要、時間及結果。
6. 最後 root 保護與 break-glass 復原路徑尚待政策決策；批准前維持禁止執行。

## CLR-03：可執行驗收矩陣

| AC | Given／When／Then 與測試層 | 現況／退出條件 |
|---|---|---|
| AC-CLR-001 | 固定來源與遠端目錄→列實體、FK、RLS、處置與責任→不漏商家 schema／物件／憑證／備份 | 本次提供來源＋目錄清冊；保存責任／期限未核可，不勾全 AC |
| AC-CLR-002 | 無權限、過期、降權、跨商家／最後 root→查閱或提交計畫→拒絕且不洩露資料 | 現有 maintenance execute 權限已唯讀核對；未實作新 API，不冒稱新權限案例已通過 |
| AC-CLR-003 | 一致快照前後→dry-run→checksum 不變、範圍雜湊可重算 | 僅有設計；待獨立沙盒與保存政策，不讀 Production 資料列做 checksum |
| AC-CLR-004 | 子表空／非空→舊函式 FK 拒絕→先前階段全回滾 | 本次四個合成案例；另需真實隔離 PostgreSQL 多 session、lock timeout、中止／恢復、Auth/Storage、outbox 防重播演練 |
| AC-CLR-005 | 未取得個別 Production 授權／備份還原證據→提出清除發布→不得建立或啟用執行入口 | 本 PR 僅文件與測試，無產品、SQL、權限或部署設定改動；未宣稱已建立 CI 技術強制閘 |

測試入口：`node --test MemberWebsocket-dev/tests/integration/platform_remove_all_data.cjs MemberWebsocket-dev/tests/integration/qa_cleanup_boundaries.cjs`。
最終提交另依 `.github/workflows/test-memberwebsocket-dev.yml` 執行完整 Node／DOM／PostgreSQL 17／Chromium／syntax／Edge typecheck／wiring／dependency audit，及 Netlify build、Ticket Policy CI。CI 最終結果記於 PR，不以本文件代替日誌。

## 待決策與後續卡的開工門檻

- 四種操作中，第一個要落地的範圍與允許環境；本稿不默認 Production 重置。
- 各資料類型的保存／匿名化／刪除期限、稽核保存邊界與資料責任人。
- root／最後管理員保護及復原責任、可用備份點與實測還原標準。
- #48 指定可重設 project/schema、Storage prefix、外發停用與互異測試身分；#35/#53 提供資料／模板版本基線。

以上未解除前，本卡維持未完成；可審查本次盤點與提案，清除功能只能另開實作卡。撤回本 PR 僅還原文件與特徵測試，不涉及資料回復。
