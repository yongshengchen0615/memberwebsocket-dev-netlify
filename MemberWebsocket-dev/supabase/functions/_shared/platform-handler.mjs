import { FEATURES, PlatformError, publicTenant, validateTenant } from './platform-policy.mjs';
import { payloadHash, sealCredentials } from './platform-crypto.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL_ERRORS = {
  PLATFORM_ADMIN_REQUIRED:[403,'僅總管理員可管理商家。'], PLATFORM_CONFLICT:[409,'資料已更新，請重新載入後再試。'],
  PLATFORM_DUPLICATE_SLUG:[409,'商家代碼已被使用。'], PLATFORM_REQUEST_CONFLICT:[409,'這個操作識別碼已用於其他內容。'],
  PLATFORM_TENANT_NOT_FOUND:[404,'找不到商家。'], PLATFORM_PROVISIONING_REQUIRED:[409,'商家尚未完成獨立資料環境驗證。'],
  PLATFORM_INVALID_INPUT:[400,'商家資料格式不正確。'], PLATFORM_APPLICATION_NOT_FOUND:[404,'找不到管理員申請。'], PLATFORM_APPLICATION_REVIEWED:[409,'申請已完成審核。'], PLATFORM_APPLICATION_NOT_APPROVED:[403,'申請尚未通過審核。'], PLATFORM_CREDENTIALS_REQUIRED:[400,'請完整設定 LINE 伺服器憑證。'], PLATFORM_IMMUTABLE_IDENTITY:[409,'已建立商家的代碼與管理員身分不可直接更換。'],
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
      if (typeof body.idToken !== 'string' || !body.idToken || body.idToken.length > 10_000) throw new PlatformError(401,'AUTH_REQUIRED','請使用 LINE 帳號登入。');
      const identity = await verifyIdentity(body.idToken);
      const actor = identity.lineUserId;
      const readOnly = ['platform.bootstrap','platform.application.bootstrap'].includes(body.action);
      const rate = await db.rpc('consume_api_rate_limit',{p_principal_hash:await payloadHash(`platform:${actor}`),
        p_is_write:!readOnly,p_cost:1,p_read_limit:60,p_write_limit:15});
      if (rate.error) throw new PlatformError(503,'RATE_LIMIT_UNAVAILABLE','目前無法確認請求頻率。');
      if (!rate.data) throw new PlatformError(429,'RATE_LIMITED','操作過於頻繁，請稍後再試。');
      const mine = async () => {
        const result = await db.rpc('platform_my_application',{p_actor:actor});
        if (result.error) throw databaseError(result.error);
        const application = result.data || null;
        return {application:application && {...application,tenant:undefined},
          tenant:application?.tenant ? publicTenant(application.tenant) : null};
      };
      if (body.action === 'platform.application.bootstrap') {
        return json({ok:true,data:{profile:{displayName:identity.displayName},features:FEATURES,...await mine()}});
      }
      if (body.action === 'platform.application.submit') {
        if (typeof body.businessName !== 'string' || body.businessName.length > 100 || !body.businessName.trim()
          || typeof body.slug !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(body.slug)
          || body.slug.length < 3 || body.slug.length > 40)
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請填寫正確的商家名稱與代碼。');
        const result = await db.rpc('platform_submit_application',{p_actor:actor,p_name:body.businessName.trim(),p_slug:body.slug});
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{...await mine()}});
      }
      if (body.action === 'platform.line.save') {
        if (!uuid.test(body.requestId || '') || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)
          throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼或資料版本不正確。');
        const workspace = await mine();
        if (workspace.application?.status !== 'approved' || !workspace.tenant)
          throw new PlatformError(403,'PLATFORM_APPLICATION_NOT_APPROVED','請先等待總管理員核准。');
        if (workspace.tenant.status === 'suspended')
          throw new PlatformError(403,'TENANT_SUSPENDED','此商家已被停用。');
        const current = workspace.tenant;
        // Disabled feature LIFF IDs are immutable to the merchant, even via a forged request.
        // Existing legacy values may be preserved but not altered without root approval.
        const featureLiffs = {membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'};
        for (const [feature,key] of Object.entries(featureLiffs)) {
          if (current.features[feature] !== true
            && String(body.line?.[key] ?? '') !== String(current.line?.[key] ?? ''))
            throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未核准，無法修改 LINE 設定。');
        }
        const validated = validateTenant({
          name:current.name,slug:current.slug,ownerLineUserId:current.ownerLineUserId,
          features:current.features,line:body.line,credentials:body.credentials,
        },!current.credentialsConfigured,{allowIncompleteFeatureLiffs:true});
        const hash = await payloadHash({expectedVersion:body.expectedVersion,line:validated.line,credentials:validated.credentials});
        const encrypted = validated.credentials.channelAccessToken
          ? await sealCredentials(current.id,validated.credentials,await encryptionKey()) : null;
        const result = await db.rpc('platform_save_my_line',{
          p_actor:actor,p_expected_version:body.expectedVersion,p_request_id:body.requestId,
          p_payload_hash:hash,p_line:validated.line,p_secrets:encrypted,
        });
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{tenant:publicTenant(result.data)}});
      }
      // All control-plane operations require the current super-admin database record.
      const auth = await db.rpc('platform_is_super_admin',{p_actor:actor});
      if (auth.error) throw databaseError(auth.error);
      if (auth.data !== true) throw new PlatformError(403,'PLATFORM_ADMIN_REQUIRED','僅總管理員可管理商家。');
      if (body.action === 'platform.bootstrap') {
        const [tenants,applications] = await Promise.all([
          db.rpc('platform_list_tenants',{p_actor:actor}),
          db.rpc('platform_list_applications',{p_actor:actor}),
        ]);
        if (tenants.error) throw databaseError(tenants.error);
        if (applications.error) throw databaseError(applications.error);
        return json({ok:true,data:{profile:{displayName:identity.displayName},
          features:FEATURES,tenants:(tenants.data || []).map(publicTenant),applications:applications.data || []}});
      }
      if (body.action === 'platform.application.approve') {
        if (!uuid.test(body.requestId || '') || !uuid.test(body.applicationId || ''))
          throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼格式不正確。');
        const features = body.features;
        if (!features || typeof features !== 'object' || Array.isArray(features)
          || Object.keys(features).length !== Object.keys(FEATURES).length
          || Object.keys(FEATURES).some(k => typeof features[k] !== 'boolean')
          || Object.keys(features).some(k => !Object.hasOwn(FEATURES,k)))
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請勾選此管理員可使用的功能。');
        const result = await db.rpc('platform_approve_application',{
          p_actor:actor,p_application_id:body.applicationId,p_features:features,p_request_id:body.requestId,
        });
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{tenant:publicTenant(result.data)}});
      }
      if (!['platform.tenant.save','platform.tenant.suspend'].includes(body.action))
        throw new PlatformError(404,'ACTION_NOT_FOUND','不支援的總管理員操作。');
      if (!uuid.test(body.requestId || '') || !uuid.test(body.tenantId || ''))
        throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼格式不正確。');
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)
        throw new PlatformError(400,'INVALID_VERSION','資料版本格式不正確。');
      let rpc;
      if (body.action === 'platform.tenant.suspend') {
        rpc = await db.rpc('platform_suspend_tenant',{p_actor:actor,p_tenant_id:body.tenantId,
          p_expected_version:body.expectedVersion,p_request_id:body.requestId});
      } else {
        const tenant = validateTenant(body.tenant,body.expectedVersion === 0);
        const hash = await payloadHash({tenantId:body.tenantId,expectedVersion:body.expectedVersion,tenant});
        const encrypted = tenant.credentials.channelAccessToken
          ? await sealCredentials(body.tenantId,tenant.credentials,await encryptionKey()) : null;
        const {credentials,...metadata} = tenant;
        rpc = await db.rpc('platform_save_tenant',{p_actor:actor,p_request_id:body.requestId,
          p_payload_hash:hash,p_tenant_id:body.tenantId,p_expected_version:body.expectedVersion,
          p_tenant:metadata,p_secrets:encrypted});
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
