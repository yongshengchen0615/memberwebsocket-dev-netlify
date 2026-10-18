// New V2 control plane, no import of legacy platform handler, auth, or config.
export const FEATURE_KEYS=Object.freeze(['membership','points','events','calendar','integrations','booking','testing','usage']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lineUser=/^U[0-9a-f]{32}$/;
const channel=/^[0-9]{5,30}$/;
const safeMessage=Object.freeze({
  V2_ROOT_REQUIRED:[403,'沒有資料庫授予的總管理員權限。'],
  V2_AUTH_REQUIRED:[401,'請重新使用 LINE 登入。'],
  V2_INVALID_INPUT:[400,'輸入資料不符合規範。'],
  V2_ALREADY_APPROVED:[409,'此申請已核准，無法修改。'],
  V2_ALREADY_REVIEWED:[409,'這筆申請已完成審核。'],
  V2_NOT_APPROVED:[403,'商家尚未通過審核或已被停權。'],
  V2_FEATURE_DISABLED:[403,'此商家尚未開啟這個功能。'],
  V2_NOT_FOUND:[404,'找不到指定資料。'],
  V2_REQUEST_CONFLICT:[409,'操作識別碼重複且內容不同。'],
  V2_VERSION_CONFLICT:[409,'資料已更新，請重新載入。'],
  V2_CREDENTIALS_REQUIRED:[400,'首次設定 LINE 時必須填寫兩項憑證。']
});
export class V2Error extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code}
}
function reject(status,code,message){throw new V2Error(status,code,message)}
const encoder=new TextEncoder();
const base64=bytes=>btoa(String.fromCharCode(...bytes));
export const sha256=async value=>{
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(value));
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
};
function readKey(secret){
  if(typeof secret!=='string'||!secret)reject(503,'KEY_NOT_CONFIGURED','平台加密金鑰尚未配置。');
  let key;try{key=Uint8Array.from(atob(secret),c=>c.charCodeAt(0))}catch{reject(503,'KEY_NOT_CONFIGURED','平台加密金鑰不正確。')}
  if(key.length!==32)reject(503,'KEY_NOT_CONFIGURED','平台加密金鑰長度不正確。');
  return key;
}
export async function sealLineCredentials(tenantId,feature,payload,keyBase64){
  if(!uuid.test(tenantId)||!FEATURE_KEYS.includes(feature))reject(400,'INVALID_TENANT','商家識別碼不正確');
  const key=await crypto.subtle.importKey('raw',readKey(keyBase64),'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const additionalData=encoder.encode(tenantId+':'+feature);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},key,encoder.encode(JSON.stringify(payload)));
  return {version:1,iv:base64(iv),data:base64(new Uint8Array(encrypted))};
}
export async function verifyLineIdToken(idToken,{channelId,fetchImpl=fetch,now=()=>Date.now()}={}){
  if(typeof idToken!=='string'||idToken.length<8||idToken.length>10000)
    reject(401,'LINE_AUTH_REQUIRED','缺少 LINE 身分憑證。');
  if(!channel.test(channelId||''))reject(503,'LINE_CHANNEL_UNCONFIGURED','平台 LINE Login Channel 尚未配置。');
  let response,payload;
  try{
    response=await fetchImpl('https://api.line.me/oauth2/v2.1/verify',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({id_token:idToken,client_id:channelId}),
      signal:AbortSignal.timeout(7000)
    });
    if(!response.ok)reject(401,'LINE_TOKEN_INVALID','LINE 登入已過期或無效。');
    payload=await response.json();
  }catch(error){
    if(error instanceof V2Error)throw error;
    reject(503,'LINE_UNAVAILABLE','LINE 驗證服務暫時無法使用。');
  }
  const clock=Math.floor(now()/1000);
  if(!payload||typeof payload!=='object'
     ||payload.aud!==channelId||payload.iss!=='https://access.line.me'
     ||!lineUser.test(payload.sub||'')
     ||!Number.isInteger(payload.iat)||!Number.isInteger(payload.exp)
     ||payload.iat>clock+60||payload.iat<=0||payload.exp<=clock||payload.exp<=payload.iat)
    reject(401,'LINE_TOKEN_INVALID','LINE 身分資料未通過驗證。');
  return {lineUserId:payload.sub,displayName:typeof payload.name==='string'?payload.name.slice(0,100):'LINE 管理員'};
}
function validFlags(input){
  return input&&typeof input==='object'&&!Array.isArray(input)
    &&Object.keys(input).length===FEATURE_KEYS.length
    &&FEATURE_KEYS.every(key=>typeof input[key]==='boolean');
}
function credentialsValid(secrets){
  if(!secrets)return true;
  const keys=Object.keys(secrets);
  return secrets&&typeof secrets==='object'&&!Array.isArray(secrets)
    &&keys.length===2&&keys.every(key=>['channelAccessToken','channelSecret'].includes(key))
    &&typeof secrets.channelAccessToken==='string'
    &&secrets.channelAccessToken.length>=20
    &&secrets.channelAccessToken.length<=4000
    &&!/[\s]/.test(secrets.channelAccessToken)
    &&typeof secrets.channelSecret==='string'
    &&/^[a-f0-9]{32}$/i.test(secrets.channelSecret);
}
function configValid(c){
  return c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).length===3
    &&channel.test(c.loginChannelId||'')&&channel.test(c.messagingChannelId||'')
    &&typeof c.liffId==='string'&&c.liffId.length<=100
    &&new RegExp('^'+c.loginChannelId+'-[A-Za-z0-9_-]+$').test(c.liffId);
}
function sqlError(error){
  const message=String(error?.message||'');
  for(const [code,[status,safe]] of Object.entries(safeMessage))
    if(message.includes(code))return new V2Error(status,code,safe);
  if(error?.code==='23505')return new V2Error(409,'UNIQUE_CONFLICT','此商家代碼或申請人已存在。');
  return new V2Error(503,'DATABASE_UNAVAILABLE','資料庫暫時無法提供服務。');
}
async function rate(db,actor,action){
  const hash=await sha256('v2:'+actor+':'+(action==='bootstrap'||action==='application.ensure'?'read':'write'));
  const result=await db.rpc('v2_rate_limit',{p_hash:hash,p_write:action!=='bootstrap'&&action!=='application.ensure'});
  if(result.error)throw sqlError(result.error);
  if(result.data!==true)reject(429,'RATE_LIMITED','操作過於頻繁，請稍後再試。');
}
async function rpc(db,name,args){
  const result=await db.rpc(name,args);
  if(result.error)throw sqlError(result.error);
  return result.data;
}
function parseBody(input){
  if(!input||typeof input!=='object'||Array.isArray(input)
      ||typeof input.action!=='string'||typeof input.idToken!=='string')
    reject(400,'INVALID_BODY','請求格式不正確。');
  return input;
}
function validateId(req){if(!uuid.test(req||''))reject(400,'INVALID_REQUEST','操作識別碼不正確。')}
function validateVersion(v){if(!Number.isSafeInteger(v)||v<1)reject(400,'INVALID_VERSION','資料版本不正確。')}
export function createPlatformV2Handler({db,allowedOrigins,lineChannelId,encryptionKey,verifyIdentity}){
  if(!db?.rpc||!(allowedOrigins instanceof Set))throw new Error('Missing V2 dependencies');
  return async request=>{
    const origin=request.headers.get('Origin');
    const allow=origin&&allowedOrigins.has(origin);
    const headers={
      'content-type':'application/json; charset=utf-8','cache-control':'no-store',
      'vary':'Origin','access-control-allow-methods':'POST,OPTIONS',
      'access-control-allow-headers':'content-type','access-control-max-age':'600'
    };
    if(allow)headers['access-control-allow-origin']=origin;
    const send=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(!allow)reject(403,'ORIGIN_FORBIDDEN','這個來源沒有權限。');
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
      if(request.method!=='POST')reject(405,'METHOD_NOT_ALLOWED','不支援的請求方式。');
      const reader=request.body?.getReader();const parts=[];let size=0;
      if(reader)try{
        while(true){const {done,value}=await reader.read();if(done)break;
          size+=value.length;if(size>16000){await reader.cancel();reject(413,'REQUEST_TOO_LARGE','請求內容過大。')}
          parts.push(value);
        }
      }finally{reader.releaseLock()}
      const data=new Uint8Array(size);let index=0;
      for(const part of parts){data.set(part,index);index+=part.length}
      let raw;try{raw=JSON.parse(new TextDecoder().decode(data))}catch{reject(400,'INVALID_BODY','請求不是合法 JSON。')}
      const body=parseBody(raw);
      const subject=await (verifyIdentity||((id)=>verifyLineIdToken(id,{channelId:lineChannelId})))(body.idToken);
      if(!lineUser.test(subject?.lineUserId||''))reject(401,'LINE_AUTH_REQUIRED','LINE 身分資料不正確。');
      const actor=subject.lineUserId;
      await rate(db,actor,body.action);
      let result;
      switch(body.action){
        case 'application.ensure':
          result=await rpc(db,'v2_ensure_application',{p_actor:actor,p_name:subject.displayName||'LINE 管理員'});break;
        case 'application.apply':
          if(typeof body.businessName!=='string'||!body.businessName.trim()||body.businessName.length>100
             ||typeof body.slug!=='string'||!(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/).test(body.slug)
             ||body.slug.length<3||body.slug.length>40)reject(400,'INVALID_INPUT','商家名稱或代碼不正確。');
          validateId(body.requestId);
          result=await rpc(db,'v2_apply',{p_actor:actor,p_name:body.businessName.trim(),p_slug:body.slug});break;
        case 'bootstrap':
          result=await rpc(db,'v2_root_bootstrap',{p_actor:actor});break;
        case 'application.approve':
          validateId(body.requestId);validateId(body.applicationId);
          if(!validFlags(body.features))reject(400,'INVALID_FEATURES','必須明確提供八項功能授權。');
          result=await rpc(db,'v2_approve',{p_actor:actor,p_app_id:body.applicationId,
            p_features:body.features,p_req:body.requestId,
            p_hash:await sha256(JSON.stringify({applicationId:body.applicationId,features:body.features}))});break;
        case 'feature.update':
          validateId(body.requestId);validateId(body.tenantId);validateVersion(body.expectedVersion);
          if(!validFlags(body.features))reject(400,'INVALID_FEATURES','必須明確提供八項功能授權。');
          result=await rpc(db,'v2_update_features',{p_actor:actor,p_tenant:body.tenantId,
            p_version:body.expectedVersion,p_features:body.features,p_req:body.requestId,
            p_hash:await sha256(JSON.stringify({tenantId:body.tenantId,version:body.expectedVersion,features:body.features}))});break;
        case 'line.save': {
          validateId(body.requestId);validateVersion(body.expectedVersion);
          if(!FEATURE_KEYS.includes(body.feature)||!configValid(body.config)||!credentialsValid(body.credentials))
            reject(400,'INVALID_LINE','LINE Channel、LIFF 或憑證格式不正確。');
          // Never trust tenant ID from a request. Resolve verified applicant -> tenant at the database.
          const owned=await rpc(db,'v2_merchant_bootstrap',{p_actor:actor});
          const tenant=owned?.tenant;
          if(owned?.application?.status!=='approved'||!tenant)
            reject(403,'V2_NOT_APPROVED','商家尚未通過審核。');
          if(tenant.status==='suspended'||tenant.features?.[body.feature]!==true)
            reject(403,'V2_FEATURE_DISABLED','此功能尚未開通或商家已停權。');
          let envelope=null;
          if(body.credentials){
            const secret=typeof encryptionKey==='function'?await encryptionKey():encryptionKey;
            envelope=await sealLineCredentials(tenant.id,body.feature,body.credentials,secret);
          }
          result=await rpc(db,'v2_save_line',{p_actor:actor,p_feature:body.feature,
            p_version:body.expectedVersion,p_config:body.config,p_envelope:envelope,
            p_req:body.requestId,
            p_hash:await sha256(JSON.stringify({feature:body.feature,version:body.expectedVersion,
              config:body.config,envelope}))});
          break;
        }
        default:reject(404,'ACTION_NOT_FOUND','未支援的操作。');
      }
      return send({ok:true,data:result});
    }catch(error){
      const safe=error instanceof V2Error?error:new V2Error(503,'V2_UNAVAILABLE','新平台服務暫時無法使用。');
      return send({ok:false,error:{code:safe.code,message:safe.message}},safe.status);
    }
  };
}
