# 預約票券同步與操作稽核

本次對應 Trello b5ihx4m8、vgHKk68b、lbl4Es6T、mpE1GqIf。

## 狀態與權益

- 預選來源為 `booking_benefit_selections`，與實際 `point_tickets`／`event_ticket_claims` 核銷分開。
- 會員可調整自己建立、狀態 pending／confirmed、尚未完成結算且不在取消審核中的一般預約。服務時間已過仍可調整，直到管理員完成服務交易。快照沿用既有 GPS／審核流程。
- 已核銷／已套用項目維持唯讀。已取消／拒絕／完成的預約不能新提交。
- 新 RPC 鎖定 booking → member，與既有 completion 保持相同順序，版本不符回報 BOOKING_CONFLICT。保留點數跨预約驗證、唯一預留索引、服務項目限制、有效期限與數量上限。
- `booking_benefit_change_requests` 只存票券選取及結果；同一 requestId 重送相同內容回傳結果，變更內容拒絕。稽核寫入與預選改動在同一交易；稽核失敗整筆回滾。
- 既有結算核銷重新驗證每日數量、點數與時效，保持交易及既有重送保護。一般預選不要求 GPS；現場直接使用仍要求原有 GPS。
- 預約或選取的 DB 異動使 points／event／admin 同步失效重讀。前端不信任事件資料決定授權；登入、資料讀寫均經原有 LINE session／測試 session 驗證。

## API

所有操作使用 POST `/functions/v1/api`，沿用所屬票券頁 LINE channel、session 撤銷及頻率限制。

- `user.pointcard.booking-selections.detail/update`（clientType points）
- `user.event.booking-selections.detail/update`（clientType event）
- detail：bookingId；回傳本人預約、已選項目與可選票券。
- update：bookingId、expectedUpdatedAt、requestId（BSEL- 開頭）、benefits [{kind,id}]。不得傳入他人的 member ID。
- `admin.audit.query`（clientType admin）：from/to、memberCode、eventAction、result、cursor、requestId（AUDQ- 開頭）。active admin 才能查詢，DB RPC 再檢查一次授權。

## 稽核事件與隱私

優先重用 audit_logs、booking_audit_events；涵蓋既有登入建立／接管、會員／條款／權益／預約／票券及管理設定事件，加上本次票券選取成功與失敗、稽核查詢事件。LINE 系統沒有本地密碼，因此本次不新增不存在的密碼更改事件；無法驗證身分的登入失敗不猜測 Actor。

稽核查詢排除瀏覽／presence／測試雜訊；識別資訊遮罩、details 僅允許必要欄位，永不回傳原始 payload、Token、密碼或聯絡資訊。篩選與 50 筆 keyset 分頁在 Server 執行，日期與 UI 時間明確使用台北時區。查詢存取紀錄採 stable request ID 去重，寫入失敗時不提供查詢結果。

既有成功事件沿用各 Domain 原有稽核；本次預選拒絕的失敗紀錄採 best effort，失敗時只在伺服器记录 DB error code，且主流程不會成功。重要預選變更與存取稽核則為交易內可靠紀錄。

稽核與新預選重送紀錄保留 365 天。每日台北 03:25 以每來源最多 1,000 筆分批清除超期紀錄，使用 skip locked，不刪會員、預約、權益或核銷資料。

## UI 範圍

移除好友中心的邀請分享區與邀請優惠中的自己 QR 顯示區；保留好友查找／掃描、會員卡 QR、優惠輸入／掃描及既有後端發券規則。相容的分享 helper 仍保留供既有整合呼叫，不再顯示已移除的按鈕。

## 部署與回退

1. CI 執行 regression、DOM／PostgreSQL integration、Chromium E2E、browser syntax、Edge typecheck。
2. 套用 `20261013043627_member_booking_selections_and_audit_query.sql`，部署更新的 api（使用相同 LINE 自訂認證，verify_jwt=false）。
3. 合併 main，確認 GitHub Pages 及 Edge health、RPC 權限、實際 DB 版本、保留工作與日誌。
4. 若需回退 UI/API，還原本 PR 程式碼；新增 table/RPC 相容保留，不刪預選或稽核。若需停止保留清除，可用 `cron.unschedule('operation-audit-retention')`。保留期已清除的超期資料不能以程式碼回退恢復。

測試採隔離 PostgreSQL／虛擬會員／Chromium transport，不核銷真實會員票券、不發真實 LINE 訊息。
