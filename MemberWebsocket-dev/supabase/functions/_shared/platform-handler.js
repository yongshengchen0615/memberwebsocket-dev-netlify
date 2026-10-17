import { FEATURES, PlatformError, publicTenant, validateTenant } from './platform-policy.js';
import { payloadHash, sealCredentials } from './platform-crypto.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL_ERRORS = {
  PLATFORM_ADMIN_REQUIRED:[403,'僅總管理員可管理商家。'], PLATFORM_CONFLICT:[409,'資料已更新，請重新載入後再試。'],
  PLATFORM_DUPLICATE_SLUG:[409,'商家代碼已被使用。'], PLATFORM_REQUEST_CONFLICT:[409,'這個操作識別碼已用於其他內容。'],
  PLATFORM_TENANT_NOT_FOUND:[404,'找不到商家。'], PLATFORM_PROVISIONING_REQUIRED:[409,'商家尚未完成獨立資料環境驗證。'],
  PLATFORM_INVALID_INPUT:[400,'商家資料格式不正確。'], PLATFORM_IMMUTABLE_IDENTITY:[409,'已建立商家的代碼與管理員身分不可直接更換。'],
};
export function databaseError(error) {
  for (const [code,[status,message]] of Object.entries(SQL_ERRORS)) if (String(error?.message || '').includes(code)) return new PlatformError(status,code,message);
  return new PlatformError(503,'PLATFORM_DATABASE_UNAVAILABLE','目前無法儲存或讀取商家設定。');
}
export function createPlatformHandler({ db, verifyIdentity, encryptionKey, allowedOrigins }) {
  return async request => {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Origin':origin && allowedOrigins.has(origin) ? origin : '',
      'Access-Control-Allow-Headers':'content-type, apikey','Access-Control-Allow-Methods':'POST,OPTIONS', 'Access-Control-Max-Age':'86400' };
    const json = (payload,status = 200) => new Response(JSON.stringify(payload),{status,headers});
    try {
      if (origin && !allowedOrigins.has(origin)) throw new PlatformError(403,'ORIGIN_NOT_ALLOWED','此網站來源未被允許。');
      if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
      if (request.method !== 'POST') throw new PlatformError(405,'METHOD_NOT_ALLOWED','不支援的請求方式。');
      // Stream-limit before parsing: Content-Length is only a hint and may be forged.
      const reader = request.body?.getReader();
      let size = 0; const chunks = [];
      if (reader) { try { while (true) { const {done,value} = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 32_000) { await reader.cancel(); throw new PlatformError(413,'BODY_TOO_LARGE','請求資料過大。'); } chunks.push(value);
      } } finally { reader.releaseLock(); } }
      let body;
      try { const data = new Uint8Array(size); let at = 0; for (const c of chunks) { data.set(c,at); at += c.length; } body = JSON.parse(new TextDecoder().decode(data)); }
      catch { throw new PlatformError(400,'INVALID_JSON','請求格式不正確。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlatformError(400,'INVALID_JSON','請求格式不正確。');
      if (typeof body.idToken !== 'string' || !body.idToken || body.idToken.length > 10_000) throw new PlatformError(401,'AUTH_REQUIRED','請使用總管理員 LINE 帳號登入。');
      const identity = await verifyIdentity(body.idToken);
      // Resolve current database state on EVERY request, including read-only calls.
      const auth = await db.rpc('platform_is_super_admin',{p_actor:identity.lineUserId});
      if (auth.error) throw databaseError(auth.error);
      if (auth.data !== true) throw new PlatformError(403,'PLATFORM_ADMIN_REQUIRED','僅總管理員可管理商家。');
      const rate = await db.rpc('consume_api_rate_limit',{ p_principal_hash:await payloadHash(`platform:${identity.lineUserId}`), p_is_write:body.action !== 'platform.bootstrap', p_cost:1, p_read_limit:60, p_write_limit:15 });
      if (rate.error) throw new PlatformError(503,'RATE_LIMIT_UNAVAILABLE','目前無法確認請求頻率。');
      if (!rate.data) throw new PlatformError(429,'RATE_LIMITED','操作過於頻繁，請稍後再試。');
      if (body.action === 'platform.bootstrap') {
        const result = await db.rpc('platform_list_tenants',{p_actor:identity.lineUserId});
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{profile:{displayName:identity.displayName},features:FEATURES,tenants:(result.data || []).map(publicTenant)}});
      }
      if (!['platform.tenant.save','platform.tenant.suspend'].includes(body.action)) throw new PlatformError(404,'ACTION_NOT_FOUND','不支援的總管理員操作。');
      if (!uuid.test(body.requestId || '') || !uuid.test(body.tenantId || '')) throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼格式不正確。');
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new PlatformError(400,'INVALID_VERSION','資料版本格式不正確。');
      let rpc;
      if (body.action === 'platform.tenant.suspend') {
        rpc = await db.rpc('platform_suspend_tenant',{p_actor:identity.lineUserId,p_tenant_id:body.tenantId,p_expected_version:body.expectedVersion,p_request_id:body.requestId});
      } else {
        const tenant = validateTenant(body.tenant, body.expectedVersion === 0);
        const hash = await payloadHash({tenantId:body.tenantId,expectedVersion:body.expectedVersion,tenant});
        const encrypted = tenant.credentials.channelAccessToken
          ? await sealCredentials(body.tenantId,tenant.credentials,encryptionKey()) : null;
        const {credentials,...metadata} = tenant;
        rpc = await db.rpc('platform_save_tenant',{p_actor:identity.lineUserId,p_request_id:body.requestId,p_payload_hash:hash,p_tenant_id:body.tenantId,p_expected_version:body.expectedVersion,p_tenant:metadata,p_secrets:encrypted});
      }
      if (rpc.error) throw databaseError(rpc.error);
      return json({ok:true,data:{tenant:publicTenant(rpc.data)}});
    } catch (error) {
      const safe = error instanceof PlatformError ? error : new PlatformError(503,'PLATFORM_UNAVAILABLE','總管理員服務暫時無法使用。');
      // Never return raw database, LINE provider or encryption errors.
      return json({ok:false,error:{code:safe.code,message:safe.message}},safe.status);
    }
  };
}
