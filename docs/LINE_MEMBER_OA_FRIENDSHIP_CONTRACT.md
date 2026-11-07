# FJG-01｜會員 LINE 官方帳號好友驗證契約（#155）

基線：`Integrated-Marketing-Platform@3b6c9b9600b20af8a929de61bc5948b3ad416c74`（2026-10-27）。父卡 #154；本階段 #155；API 強制註冊 #156；引導/Webhook #157、#158；真 LINE/Preview #159。

## 本輪結果邊界

**本 PR 只增加未接入註冊路徑的純伺服器 LINE 查驗器、八個單元負向/正常測試及這份契約，不會阻止現有會員註冊。** 不改 DB/Edge 部署/LINE Console/Netlify Production。沒有真實 LINE token 或 linked OA 測試結果時，不得宣稱 #155、#156 或整體功能已完成。

## 第一性原理：目標、身分、權限、狀態、資料、限制

| 面向 | 已確認程式事實及安全邊界 | 尚需完成 |
|---|---|---|
| 身分 | `supabase/functions/api/index.ts` 的 ID Token 驗證與 `_shared/auth-contract.ts` 檢查 LINE `aud/sub`、issuer/expiry、撤權及 session。 | Access Token 必須另以 LINE API 驗證 Channel、profile scope、User ID 和好友資格；不可只信 `liff.getFriendship()`。 |
| 租戶 | `business-context.js` 傳 business slug；`_shared/business-runtime.ts` 從核准功能和 tenant Channel 決定註冊路由；`business-scope.ts` 綁定執行期環境。 | Client 傳來的 slug、`friendFlag`、Channel 不能被當授權來源；A 店不能換成 B 店用戶資格。 |
| 官方帳號 | #144 已指定每商家獨立 admin OA 與 member OA；#59 現有 LIFF / Login Channel 設定。 | 必須人工/可信設定確認 member OA 與該店 LINE Login Channel **同 Provider 且已 Linked**；管理 OA 不能代替。缺此證據就 503，不靜默放行。 |
| 啟用 | `api/index.ts` 中 `user.member.profile.save` 在條款 RPC 後將 `membership_status` 設成 `active`；`ensureMember` 可先建立未啟用會員。 | 尚無伺服器好友驗證 Gate；#156 需盤點 **包括 `member-profile-api`、所有 RPC** 的首次啟用入口，以原子 DB 交易保證 pending→active 至多一次。 |
| 相容性 | 既有會員、預約/點數/票券/推薦獎勵、跨商家授權與通知不能受退化。 | 本次只設計新會員**首次啟用**限制；既有已啟用會員日後封鎖 OA 不自動停權/刪除（#156 目前工作假設）。 |

## 驗證器契約

`verifyMemberOaFriendship({ expectedChannelId, expectedLineUserId, memberOaLinked, accessToken, fetchImpl?, timeoutMs? })`

`expectedChannelId` 必須來自服務端核准 tenant 的 **會員 Login Channel**，不是 Messaging API Channel。`expectedLineUserId` 必須來自服務端對該 Channel 已驗證 ID Token 的 `sub`。`memberOaLinked` 僅能來自可信伺服器端對 LINE Developers linked member OA 的核驗結果，絕不接受前端布林值。Access Token 不寫 DB/日誌、不傳到前端回應。

驗證順序：連結未確認先拒絕 → LINE `GET /oauth2/v2.1/verify` 查 `client_id`、`profile` scope、有效期 → `GET /v2/profile` 查 User ID 一致 → `GET /friendship/v1/status` 僅 `friendFlag === true` 放行。429/5xx/timeout/格式錯誤一律可重試的 503；未加好友或封鎖為 403；身份或 Channel 錯誤為 401。依 LINE 官方要求，verify GET query 帶 access token，因此**不可在應用及外部追蹤工具紀錄完整 URL/query**。

後續整合應先執行速率限制，檢查條款與角色；對會員啟用及歸因/發券採唯一約束、交易和冪等，避免重試或併發產生多筆有效會員或獎勵。Webhook follow/unfollow 不可取代註冊當下的官方查驗。

## 選型

| 方案 | 優點 | 缺點／決策 |
|---|---|---|
| 純前端 `liff.getFriendship()` | UI 流暢、好引導 | 可繞過 API，不符合 AC；只供 #157 顯示 |
| 逐店可信綁定 + 後端 Access Token 驗證 | 綁定 Channel/User/OA，易測拒絕與故障 | 先確認官方 Linked OA，再接入；**選此方案** |

## Given／When／Then 測試對照

| AC | 驗收 | 已有證據／缺口 |
|---|---|---|
| AC-001 | Given A 店正確 member OA 與身份，When 驗證，Then 通過；B 店 Channel/身份不能混用 | Helper 合成成功、Channel mismatch、Profile mismatch；真實兩店 Provider 待 #159 |
| AC-002 | Given OA 未 linked、缺 scope、錯 Channel 或前端冒填 `friendFlag`，When 查驗，Then fail-closed | Helper 合成配置及身份負向已測；API direct-call 待 #156 |
| AC-003 | Given LINE 429/5xx/timeout/不正確回應，When 查驗，Then 拒絕且不建立有效會員 | Helper 失敗路徑已測；資料庫與復原待 #156 |
| AC-004 | Given 會員未加 OA 或封鎖，When 查驗，Then 403；舊有效會員不被重設 | Helper `friendFlag=false` 已測；端到端待 #156/#159 |

本機命令：`node --test MemberWebsocket-dev/tests/member_oa_friendship_gate.test.js`。最終交付須由現有 `test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml` 完整測試，報告 exact SHA、實際 exits/pass/fail/skip；真人 LINE、完整 API、DB transaction、跨店、Preview smoke 均是後續必驗，不能以 mock 取代。

官方規範：https://developers.line.biz/en/docs/line-login/web/link-a-bot 及 https://developers.line.biz/en/reference/line-login/ 。

## 待完成與回復

1. #155：逐店檢查 LINE Developers Provider、member OA Linked、LIFF `profile`、入口網址、Channel；證據不足不標 Done。
2. #156：檢查所有首次 activation 路徑、RLS/SQL RPC，在後端權限與交易界線上接入驗證；先 RED 測試，再完整回歸。
3. #157–159：會員 UI 引導、Webhook 去重及真 LINE Provider/E2E 獨立核驗。
4. 回復：revert 此 PR 刪除輔助模組/測試/文件；沒有需回復的資料庫或已發布 Edge 版本。
