// V2 is deliberately disconnected from legacy config.json, Supabase endpoints,
// old session stores and legacy API. No secret or ID token is persisted.
export const FEATURES=Object.freeze({
  membership:'會員卡',points:'集點卡',events:'活動票券',calendar:'營運日曆',
  integrations:'整合中心',booking:'預約',testing:'測試中心',usage:'使用紀錄'
});
export async function loadConfig(fetchImpl=fetch){
  const url=new URL('../config.json',import.meta.url);
  const response=await fetchImpl(url,{cache:'no-store'});
  if(!response.ok)throw new Error('V2 設定讀取失敗');
  const cfg=await response.json();
  if(!cfg || typeof cfg.apiUrl!=='string' || !/^https:\/\/[a-z0-9.-]+\/functions\/v1\/platform-v2\/?$/.test(cfg.apiUrl)
     || typeof cfg.platformLiffId!=='string' || !/^\d+-[A-Za-z0-9_-]+$/.test(cfg.platformLiffId))
    throw new Error('全新 Supabase 環境尚未配置；不會使用舊版連線');
  return cfg;
}
export async function callApi(config,idToken,action,data={},fetchImpl=fetch){
  if(typeof idToken!=='string'||!idToken)throw new Error('LINE 身分已過期，請重新登入');
  const response=await fetchImpl(config.apiUrl,{
    method:'POST',mode:'cors',cache:'no-store',headers:{'content-type':'application/json'},
    body:JSON.stringify({action,idToken,...data})
  });
  let payload;try{payload=await response.json()}catch{throw new Error('伺服器回傳格式錯誤')}
  if(!response.ok||!payload?.ok)throw new Error(payload?.error?.message||'無法完成操作');
  return payload.data;
}
export function isEnabled(features,feature){return Object.hasOwn(FEATURES,feature)&&features?.[feature]===true}
