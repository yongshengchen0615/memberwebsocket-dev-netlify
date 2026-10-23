# #97 管理員資格資料基礎

## 需求與範圍
依 Issue #97 的 `issue97-clarified-user-flow-20261023` 決策，管理員資格與每店審核分開。本工作包交付可獨立驗證的資格資料模型、送件、root 審核、狀態讀取及非破壞 backfill。這是後續 API/UI 的基礎，不是已完成雙層審核產品。

既有商家 applications、tenants、grants、LINE 憑證與業務資料保持原狀；本批不移除單筆商家 UNIQUE、不修改既有函式、不接入 Edge/UI、不部署遠端。舊版商家入口仍沿用舊授權，不能宣稱資格停權已影響它。整卡不移 QA/Done。

## 方案
沿用單一商家 approved flag 不符合已確定需求；立即改動所有單筆呼叫會把資料、Edge、UI 的遷移綁在一起。本批採已選定的獨立資格模型，先以新增契約隔離交付；未接線的能力保持 Draft。

## 契約
- `platform_private.admin_qualifications`：每個可信 LINE actor 一筆；pending/approved/rejected/suspended、版本、申請/審核時間、審核理由與存取撤銷時間。
- `platform_my_admin_qualification(text)`：純讀取；未申請回 null，不自動送件。
- `platform_submit_admin_qualification(text,text,uuid)`：明確送件；新件 pending，pending/approved 不重複建立；rejected 可重新送件；suspended 不可自行恢復。
- `platform_list_admin_qualifications(text)`：只有現有 root 可讀取完整待審清單。
- `platform_review_admin_qualification(text,uuid,integer,text,text,uuid)`：現有 root＋樂觀版本控制；pending→approved/rejected、approved→suspended、suspended→approved；其他轉換拒絕。拒絕/停權理由 1–500 字。
- requestId 全域冪等；相同 ID 不同 actor/操作/內容拒絕。重送成功請求回目前狀態，不能回傳過期 approved。狀態、版本、稽核與 request 在同一交易。
- 現有 approved application 映射 approved 資格；pending/rejected 原狀映射。無案件者保持未申請；不根據一般 admins row 或 root 身分自行核准。不更新原表。
- 新表 RLS、私有 schema；函式 SECURITY INVOKER / empty search_path；anon/authenticated 無表或函式權限，僅可信後端 service_role 可呼叫。p_actor 必須由後續 Edge 的真實 LINE 驗證提供，絕不可直接取自 client payload。

## 後續接線門檻
完整 #97 還需要 tenant 明確選擇、所有 legacy singleton RPC 的切換、管理員資格撤權套用到每個業務 API、同 owner 多店隔離、雙端 UI、真實 PostgreSQL 併發與 Preview/LINE 驗收。本批不得單獨部署後宣稱這些已完成。
