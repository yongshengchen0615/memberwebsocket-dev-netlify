// Sends an application receipt from the verified frontdesk LINE Official Account.
// Only server-side callers can supply the stored channel access token.
const staffUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lineUser=/^U[0-9a-f]{32}$/i;
const officialAccount=/^@[a-z0-9._-]{3,40}$/i;
const label=value=>String(value||'').replace(/[\r\n\t\u0000-\u001f]+/g,' ').trim().slice(0,100);
export function frontdeskApplicationText({merchantName,applicant}) {
 return ['【櫃檯人員權限申請】',`商家：${label(merchantName)||'商家'}`,`申請人：${label(applicant)||'櫃檯人員'}`,'狀態：等待商家管理員審核','請由商家管理端「LINE 設定 → 預約 → 櫃檯官方帳號與人員權限」確認申請。','核准前無法使用櫃檯權限。'].join('\n');
}
export function frontdeskApplicationChatLink({oaId,merchantName,applicant}) {
 if(!officialAccount.test(String(oaId||'')))return null;
 return `https://line.me/R/oaMessage/${encodeURIComponent(oaId)}/?${encodeURIComponent(frontdeskApplicationText({merchantName,applicant}))}`;
}
export async function sendFrontdeskApplicationLineMessage({staff,actor,merchantName,channelAccessToken,fetchImpl=fetch}) {
 if(staff?.status!=='pending'||!staffUuid.test(staff.id||'')||!lineUser.test(actor||'')||typeof channelAccessToken!=='string'||!channelAccessToken.trim())
  return {status:'not_applicable'};
 try {
  const response=await fetchImpl('https://api.line.me/v2/bot/message/push',{
   method:'POST',headers:{Authorization:`Bearer ${channelAccessToken}`,'Content-Type':'application/json','X-Line-Retry-Key':staff.id},
   body:JSON.stringify({to:actor,messages:[{type:'text',text:frontdeskApplicationText({merchantName,applicant:staff.displayName})}]}),
   signal:AbortSignal.timeout(8000),
  });
  // LINE reports an accepted replay as 409 with the accepted-request header.
  const duplicate=response.status===409&&!!response.headers?.get?.('x-line-accepted-request-id');
  return {status:response.ok||duplicate?'sent':'failed'};
 }catch{return {status:'failed'};}
}
