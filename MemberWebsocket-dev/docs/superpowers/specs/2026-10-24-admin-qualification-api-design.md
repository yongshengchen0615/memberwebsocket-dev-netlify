# #97 管理員資格 API 接線

權限用詞：本文件的 root 是既有程式對 Platform 總管理員的歷史簡稱；審核資格以 `platform_is_super_admin` 當下結果為準，包含已核准的非 singleton 總管理員。Supabase DBA 核准 Platform 總管理員與 `platform_is_root_super_admin` 的 singleton 管理權限不是本批審核資格的必要條件。

依 #97 已確認的雙層審核需求，延續 PR #102 的獨立資格 SQL；本批完成可獨立驗證的後端 API，不切換既有單商家 UI，也不部署部分流程。沿用 LINE 服務端驗證、現有 rate limiter、SQL invoker RPC 與交易式冪等機制。

新增四個 action：`platform.qualification.bootstrap`（申請者純讀，未申請為 null）、`platform.qualification.submit`（明確送件，姓名／actor 來自 LINE）、`platform.qualification.list`（當前 root 清單）、`platform.qualification.review`（當前 root，UUID／版本／決策／理由驗證）。申請者使用既有一般管理員 Channel，root 使用平台 Channel。資格 action 不接受 business context，避免資格綁到某個商家 Channel。

審核限定 pending→approved/rejected、approved→suspended、suspended→approved，SQL 為狀態權威。重送回目前狀態，撤權後舊 request 不可取得權限。資格核准不建立 merchant、tenant、功能 grant 或 root。

方案比較：直接修改 legacy bootstrap 會在多商家／UI 尚未接線時改變使用者旅程；本批採新增 action，能先完整驗證契約。全卡完成前維持 Draft，不能單獨部署或宣稱資格停權已限制 legacy 業務 API。

驗收 AC-MMA-API-001～012：純讀與明確送件、可信身分、總管理員 list/review、版本／冪等、拒絕／重提／停復權、無效輸入、撤回管理員、錯誤遮蔽、非 singleton 總管理員與讀寫限流，以及原 legacy 行為回歸。外部 LINE 使用 provider stub；fixture 的 shared limiter 採可控制回應，以驗證 handler 的限流拒絕／故障及讀寫預算選擇，limiter 本身沿用既有基線。真實 LINE 不計通過。
