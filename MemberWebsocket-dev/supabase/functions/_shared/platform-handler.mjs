import { featureLineReady } from './merchant-onboarding.mjs';
import { FEATURES, PlatformError, publicTenant, validateTenant } from './platform-policy.mjs';
import { payloadHash, sealCredentials, openCredentials } from './platform-crypto.mjs';
import { assertTenantIdentity, normalizeExpiry } from './tenant-access.mjs';
import { validateNotificationRoute, verifyNotificationToken } from './notification-routes.mjs';
import { checkLineWebhook, lineWebhookEndpoint } from './line-webhook-diagnostics.mjs';
import { memberOaGuidance } from './member-oa-registration-gate.mjs';
import { inspectMemberOaOwnership } from './member-oa-ownership.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL_ERRORS = {
  LINE_CHANNEL_IN_USE:[409,'此 Messaging API Channel 已綁定其他商家。'],
  LINE_DESTINATION_IN_USE:[409,'此官方帳號已綁定其他 Messaging API Channel，請確認 Channel 設定。'],
  LINE_WEBHOOK_STALE:[409,'LINE 設定已變更，請重新載入並檢查連線。'],
  PLATFORM_ADMIN_REQUIRED:[403,'僅總管理員可管理商家。'], PLATFORM_CONFLICT:[409,'資料已更新，請重新載入後再試。'],
  PLATFORM_QUALIFICATION_SUSPENDED:[403,'管理員資格已停權，請聯絡總管理員。'],
  PLATFORM_QUALIFICATION_REQUIRED:[403,'請先取得一般管理員資格。'],
  PLATFORM_BUSINESS_SELECTION_REQUIRED:[409,'請先選擇要管理的商家。'],
  PLATFORM_MERCHANT_API_REQUIRED:[409,'請使用新版商家申請流程。'],
  TENANT_REAUTH_REQUIRED:[401,'使用資格曾被停用，請重新使用 LINE 登入。'],
  PLATFORM_QUALIFICATION_NOT_FOUND:[404,'找不到管理員資格申請。'],
  PLATFORM_QUALIFICATION_TRANSITION:[409,'目前資格狀態不允許此操作，請重新載入。'],
  PLATFORM_FEATURE_DISABLED:[403,'此功能尚未核准。'], PLATFORM_RESUME_NOT_READY:[409,'商家尚未完成開通，無法復權。'], TENANT_EXPIRED:[403,'使用期限已到，請聯絡總管理員。'],
  PLATFORM_DUPLICATE_SLUG:[409,'商家代碼已被使用。'], PLATFORM_REQUEST_CONFLICT:[409,'這個操作識別碼已用於其他內容。'],
  PLATFORM_TENANT_NOT_FOUND:[404,'找不到商家。'], PLATFORM_PROVISIONING_REQUIRED:[409,'商家尚未完成獨立資料環境驗證。'],
  PLATFORM_SUPABASE_ONLY_APPROVAL:[403,'Platform 管理權限只能由 Supabase 管理者修改。'],
  PLATFORM_ROOT_REQUIRED:[403,'只有最高管理員可以核准或撤銷 Platform 管理權。'],
  PLATFORM_SELF_OR_ROOT_REVIEW_FORBIDDEN:[403,'不可核准自己或變更最高管理員權限。'],
  PLATFORM_ACCESS_REQUEST_NOT_FOUND:[404,'找不到待審核的 Platform 管理員登入紀錄。'],
  PLATFORM_INVALID_ACCESS_REVIEW:[400,'權限核准資料不正確。'],
  PLATFORM_INVALID_ACCESS_IDENTITY:[400,'LINE 身分資料格式不正確。'],
  PLATFORM_INVALID_INPUT:[400,'商家資料格式不正確。'], PLATFORM_APPLICATION_NOT_FOUND:[404,'找不到管理員申請。'], PLATFORM_APPLICATION_REVIEWED:[409,'申請已完成審核。'], PLATFORM_APPLICATION_NOT_APPROVED:[403,'申請尚未通過審核。'], PLATFORM_CREDENTIALS_REQUIRED:[400,'請完整設定 LINE 伺服器憑證。'], PLATFORM_IMMUTABLE_IDENTITY:[409,'已建立商家的代碼與管理員身分不可直接更換。'],
};
export function databaseError(error) {
  for (const [code,[status,message]] of Object.entries(SQL_ERRORS)) if (String(error?.message || '').includes(code)) return new PlatformError(status,code,message);
  return new PlatformError(503,'PLATFORM_DATABASE_UNAVAILABLE','目前無法儲存或讀取商家設定。');
}
export function createPlatformHandler({ db, verifyIdentity, verifyApplicantIdentity = verifyIdentity, encryptionKey, allowedOrigins, fetchImpl = fetch, publicSupabaseUrl, verifiedMemberOaBindingsJson = '', allowedActions = null }) {
  const moduleCredentials = async (current, feature) => {
    const stored=await db.rpc('platform_module_credentials',{p_tenant_id:current.id,p_feature:feature});
    if(stored.error)throw databaseError(stored.error);
    if(stored.data?.envelope || current.moduleLine?.[feature] || !current.credentialsConfigured)return stored;
    // A legacy tenant envelope can be inherited only before this module owns a
    // configuration. Its AES associated data remains the tenant identifier.
    const legacy=await db.rpc('platform_business_credentials',{p_tenant_id:current.id});
    if(legacy.error)throw databaseError(legacy.error);
    return {data:legacy.data?{envelope:legacy.data,scope:'tenant'}:null,error:null};
  };
  return async request => {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Origin':origin && allowedOrigins.has(origin) ? origin : '',
      'Access-Control-Allow-Headers':'content-type, apikey','Access-Control-Allow-Methods':'POST,OPTIONS', 'Access-Control-Max-Age':'86400' };
    const json = (payload,status = 200) => new Response(JSON.stringify(payload),{status,headers});
    let webhookActor;
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
      if (allowedActions && !allowedActions.has(body.action)) throw new PlatformError(404,'ACTION_NOT_FOUND','預覽端點不支援此操作。');
      if(body.action==='platform.business.public'){
        if(typeof body.business!=='string'||!/^[-a-z0-9]{3,40}$/.test(body.business))throw new PlatformError(400,'INVALID_BUSINESS','商家入口格式不正確。');
        const limited=await db.rpc('consume_api_rate_limit',{p_principal_hash:await payloadHash('business-public:'+body.business+':'+(request.headers.get('x-forwarded-for')||'')),p_is_write:false,p_cost:1,p_read_limit:90,p_write_limit:15});
        if(limited.error||!limited.data)throw new PlatformError(429,'RATE_LIMITED','請稍後再試。');
        const result=await db.rpc('platform_business_context',{p_actor:null,p_slug:body.business});
        if(result.error)throw databaseError(result.error);
        if(!result.data)throw new PlatformError(404,'BUSINESS_NOT_FOUND','找不到商家入口。');
        const tenant=publicTenant(result.data);
        if(tenant.expired)throw new PlatformError(403,'TENANT_EXPIRED','使用期限已到，請聯絡總管理員。');
        if(!tenant.capabilities.dataPlaneVerified)throw new PlatformError(403,'TENANT_SUSPENDED','此商家尚未開放或已停用。');
        const module=body.feature && tenant.features[body.feature]===true?tenant.moduleLine?.[body.feature]:null;
        if(body.feature!==undefined && (!Object.hasOwn(FEATURES,body.feature)||tenant.features[body.feature]!==true))throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未開放。');
        return json({ok:true,data:{business:tenant.slug,name:tenant.name,features:tenant.features,
          line:body.feature && featureLineReady(body.feature,{...tenant.line,...module?.line})?{...tenant.line,...module?.line}:tenant.onboarding.configurationComplete?tenant.line:{adminChannelId:tenant.line?.adminChannelId||'',adminLiffId:tenant.line?.adminLiffId||''}}});
      }
      if (typeof body.idToken !== 'string' || !body.idToken || body.idToken.length > 10_000) throw new PlatformError(401,'AUTH_REQUIRED','請使用 LINE 帳號登入。');
      const qualificationAction = ['platform.qualification.bootstrap','platform.qualification.submit','platform.qualification.list','platform.qualification.review'].includes(body.action);
      const merchantAction = ['platform.merchant.list','platform.merchant.get','platform.merchant.submit','platform.merchant.review'].includes(body.action);
      if ((qualificationAction || merchantAction) && body.business !== undefined)
        throw new PlatformError(400,'PLATFORM_INVALID_INPUT','資格與商家申請不接受商家入口。');
      const applicantAction = ['platform.member-oa.inspect','platform.member-oa.readiness','platform.webhook.status','platform.webhook.check','platform.application.bootstrap','platform.application.ensure','platform.application.submit','platform.line.save','platform.notifications.save','platform.notifications.test','platform.qualification.bootstrap','platform.qualification.submit','platform.merchant.list','platform.merchant.get','platform.merchant.submit'].includes(body.action);
      let trustedChannel;
      if (applicantAction && body.business !== undefined) {
        if (typeof body.business !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(body.business) || body.business.length > 40)
          throw new PlatformError(400,'INVALID_BUSINESS','商家入口格式不正確。');
        const context = await db.rpc('platform_business_context',{p_actor:null,p_slug:body.business});
        if (context.error) throw databaseError(context.error);
        if (!context.data) throw new PlatformError(403,'BUSINESS_FORBIDDEN','無法存取此商家設定。');
        const business = publicTenant(context.data);
        if (!business.capabilities.dataPlaneVerified) throw new PlatformError(403,'TENANT_SUSPENDED','此商家尚未開放或已停用。');
        // Match the login channel used by BusinessContext; never trust a request's channel ID.
        if (business.line?.adminLiffId?.startsWith(business.line.adminChannelId+'-')) trustedChannel = business.line.adminChannelId;
      }
      const identity = await (applicantAction ? verifyApplicantIdentity : verifyIdentity)(body.idToken, trustedChannel);
      const actor = identity.lineUserId;
      if(['platform.webhook.status','platform.webhook.check'].includes(body.action))webhookActor=actor;
      const readOnly = ['platform.member-oa.inspect','platform.member-oa.readiness','platform.webhook.status','platform.bootstrap','platform.application.bootstrap','platform.qualification.bootstrap','platform.qualification.list','platform.merchant.list','platform.merchant.get'].includes(body.action);
      const rate = await db.rpc('consume_api_rate_limit',{p_principal_hash:await payloadHash(`platform:${actor}`),
        p_is_write:!readOnly,p_cost:1,p_read_limit:60,p_write_limit:15});
      if (rate.error) throw new PlatformError(503,'RATE_LIMIT_UNAVAILABLE','目前無法確認請求頻率。');
      if (!rate.data) throw new PlatformError(429,'RATE_LIMITED','操作過於頻繁，請稍後再試。');
      if (body.action === 'platform.qualification.bootstrap') {
        const result = await db.rpc('platform_my_admin_qualification',{p_actor:actor});
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{qualification:result.data ?? null}});
      }
      if (body.action === 'platform.qualification.submit') {
        if (typeof body.requestId !== 'string' || !uuid.test(body.requestId))
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','操作識別碼格式不正確。');
        const name = Array.from(String(identity.displayName || 'LINE 管理員').trim() || 'LINE 管理員').slice(0,100).join('');
        const result = await db.rpc('platform_submit_admin_qualification',{
          p_actor:actor,p_name:name,p_request_id:body.requestId,
        });
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{qualification:result.data}});
      }
      // Account-level merchant applications use the fixed applicant Channel.
      // SQL checks the verified actor's current qualification and row ownership.
      const merchantResponse = application => application && {
        id:application.id,qualificationId:application.qualificationId,
        businessName:application.businessName,slug:application.slug,status:application.status,version:application.version,
        requestedAt:application.requestedAt,updatedAt:application.updatedAt,
        reviewedAt:application.reviewedAt,reviewReason:application.reviewReason,
        tenant:application.tenant ? publicTenant(application.tenant) : null,
      };
      const validId = value => typeof value === 'string' && uuid.test(value);
      const validVersion = value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
      if (body.action === 'platform.merchant.list') {
        const result = await db.rpc('platform_my_merchant_applications',{p_actor:actor});
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{applications:(result.data || []).map(merchantResponse)}});
      }
      if (body.action === 'platform.merchant.get') {
        if (!validId(body.applicationId)) throw new PlatformError(400,'PLATFORM_INVALID_INPUT','商家申請識別碼格式不正確。');
        const result = await db.rpc('platform_get_merchant_application',{p_actor:actor,p_application_id:body.applicationId});
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{application:merchantResponse(result.data)}});
      }
      if (body.action === 'platform.merchant.submit') {
        if (!validId(body.requestId) || typeof body.businessName !== 'string'
          || !body.businessName.trim() || Array.from(body.businessName.trim()).length > 100
          || body.slug !== undefined
          || (body.applicationId === undefined ? body.expectedVersion !== undefined
            : !validId(body.applicationId) || !validVersion(body.expectedVersion)))
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請確認商家名稱、申請版本與操作識別碼；商家代碼由系統分配，舊頁面請重新整理。');
        // Stable across an uncertain retry; the SQL transaction still enforces
        // request ownership, payload consistency and globally unique codes.
        let slug = 'm-' + body.requestId.toLowerCase().replaceAll('-','');
        if (body.applicationId !== undefined) {
          const current = await db.rpc('platform_get_merchant_application',{p_actor:actor,p_application_id:body.applicationId});
          if (current.error) throw databaseError(current.error);
          if (!current.data) throw new PlatformError(404,'PLATFORM_APPLICATION_NOT_FOUND','找不到商家申請。');
          slug = current.data.slug;
        }
        const result = await db.rpc('platform_submit_merchant_application',{
          p_actor:actor,p_name:body.businessName.trim(),p_slug:slug,p_request_id:body.requestId,
          p_application_id:body.applicationId ?? null,p_expected_version:body.expectedVersion ?? null,
        });
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{application:merchantResponse(result.data)}});
      }
      const mine = async () => {
        const context = slug => db.rpc('platform_my_merchant_context',{
          p_actor:actor,p_slug:slug,p_issued_at:new Date(identity.issuedAtMs).toISOString(),
        });
        let result = body.business !== undefined ? await context(body.business)
          : await db.rpc('platform_my_application',{p_actor:actor});
        // Before the coordinated schema upgrade, a legacy singleton has no
        // qualificationId. Once migrated, even an old singleton client must use
        // the current qualification/fresh-token gate; ambiguous owners fail in SQL.
        if (!result.error && body.business === undefined && result.data?.qualificationId)
          result = await context(result.data.slug);
        if (result.error) throw databaseError(result.error);
        const application = result.data || null;
        if (body.business !== undefined && application?.tenant?.slug !== body.business)
          throw new PlatformError(403,'BUSINESS_FORBIDDEN','無法存取其他商家的設定。');
        try { assertTenantIdentity(application?.tenant,identity); }
        catch(error) { throw new PlatformError(error.status,error.code,error.message); }
        return {application:application && {...application,tenant:undefined},
          tenant:application?.tenant ? publicTenant(application.tenant) : null};
      };
      const merchantWrite = (name,params,workspace) => db.rpc(
        workspace.application?.qualificationId ? name+'_for_merchant' : name,
        {...params,...(workspace.application?.qualificationId ? {
          p_tenant_id:workspace.tenant.id,p_issued_at:new Date(identity.issuedAtMs).toISOString(),
        } : {})});
      const configurationReplay = async (workspace,feature,operation,hash) => {
        const result=await db.rpc('platform_configuration_replay',{
          p_actor:actor,p_tenant_id:workspace.tenant.id,p_issued_at:new Date(identity.issuedAtMs).toISOString(),
          p_feature:feature,p_operation:operation,p_request_id:body.requestId,p_payload_hash:hash,
          p_scoped:Boolean(workspace.application?.qualificationId),
        });
        if(result.error)throw databaseError(result.error);
        return result.data;
      };
      if (body.action === 'platform.application.ensure') {
        // Identity and initial name come only from LINE verification. The SQL
        // actor lock and unique constraint make simultaneous first visits safe.
        let workspace = await mine();
        if (!workspace.application) {
          const name = Array.from(String(identity.displayName || 'LINE 管理員').trim() || 'LINE 管理員').slice(0,100).join('');
          const result = await db.rpc('platform_submit_application',{
            p_actor:actor,p_name:name,p_slug:'admin-'+crypto.randomUUID().replaceAll('-',''),
          });
          if (result.error) throw databaseError(result.error);
          workspace = await mine();
        }
        return json({ok:true,data:{profile:{displayName:identity.displayName},features:FEATURES,...workspace}});
      }
      if (body.action === 'platform.application.bootstrap') {
        return json({ok:true,data:{profile:{displayName:identity.displayName},features:FEATURES,...await mine()}});
      }
      // This is an authenticated, per-business preflight; it exposes no secrets,
      // friend state or OA identity, and uses the same trusted binding resolver as activation.
      if (body.action === 'platform.member-oa.inspect') {
        if (typeof body.business !== 'string') throw new PlatformError(400,'INVALID_BUSINESS','請先選擇商家。');
        const workspace=await mine(),current=workspace.tenant;
        if (!current || workspace.application?.status!=='approved' || !current.capabilities.dataPlaneVerified)
          throw new PlatformError(403,'BUSINESS_FORBIDDEN','無法存取此商家設定。');
        if (current.features?.membership!==true)
          throw new PlatformError(403,'FEATURE_DISABLED','此商家尚未開放會員卡。');
        const stored=await moduleCredentials(current,'membership');
        if(stored.error)throw databaseError(stored.error);
        if(!stored.data?.envelope)
          throw new PlatformError(409,'MEMBER_OA_TOKEN_REQUIRED','請先儲存本店會員官方帳號的 Messaging API 憑證。');
        const credentials=await openCredentials(stored.data.scope==='module'
          ?current.id+':membership':current.id,stored.data.envelope,await encryptionKey());
        const line={...current.line,...current.moduleLine?.membership?.line};
        const inspected=await inspectMemberOaOwnership({line,credentials,fetchImpl});
        return json({ok:true,data:inspected});
      }
      if (body.action === 'platform.member-oa.readiness') {
        if (typeof body.business !== 'string') throw new PlatformError(400,'INVALID_BUSINESS','請先選擇商家。');
        const workspace = await mine(), current = workspace.tenant;
        if (!current || workspace.application?.status !== 'approved' || !current.capabilities.dataPlaneVerified)
          throw new PlatformError(403,'BUSINESS_FORBIDDEN','無法存取此商家設定。');
        if (current.features?.membership !== true)
          throw new PlatformError(403,'FEATURE_DISABLED','此商家尚未開放會員卡。');
        const memberLine = {...current.line,...current.moduleLine?.membership?.line};
        const guidance = memberOaGuidance({
          tenant:{id:current.id,features:current.features,line_config:current.line||{},module_line:current.moduleLine||{}},
          expectedChannelId:memberLine.memberChannelId,member:null,verifiedBindingsJson:verifiedMemberOaBindingsJson,
        });
        return json({ok:true,data:{configured:guidance.configured,tenantVersion:current.version}});
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
      if (['platform.webhook.status','platform.webhook.check'].includes(body.action)) {
        if(typeof body.business!=='string')throw new PlatformError(400,'INVALID_BUSINESS','請先選擇要檢查的商家。');
        const workspace=await mine(),current=workspace.tenant;
        if(!current || workspace.application?.status!=='approved' || !current.capabilities.dataPlaneVerified)
          throw new PlatformError(403,'TENANT_SUSPENDED','此商家尚未開放或已停用。');
        if(!['membership','points','events','calendar','booking'].includes(body.feature) || current.features?.[body.feature]!==true)
          throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未核准。');
        const endpoint=lineWebhookEndpoint(publicSupabaseUrl);
        const args={p_actor:actor,p_tenant_id:current.id,p_issued_at:new Date(identity.issuedAtMs).toISOString(),p_feature:body.feature};
        const read=await db.rpc(body.action==='platform.webhook.check'?'platform_line_webhook_prepare':'platform_line_webhook_status',args);
        if(read.error)throw databaseError(read.error);
        let summary=read.data;
        if(body.action==='platform.webhook.check'){
          const destination=await checkLineWebhook({candidate:read.data,encryptionKey,fetchImpl});
          const bound=await db.rpc('platform_line_webhook_bind',{...args,p_channel_id:read.data.channelId,p_destination:destination,p_revision:read.data.revision});
          if(bound.error)throw databaseError(bound.error);summary=bound.data;
        }
        return json({ok:true,data:{...summary,endpoint}});
      }
      if (body.action === 'platform.notifications.test') {
        validateNotificationRoute({...body,mode:'inherit'});
        if (!uuid.test(body.requestId || '') || !Number.isSafeInteger(body.expectedVersion)) throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼或資料版本不正確。');
        const workspace=await mine(),current=workspace.tenant;
        if (workspace.application?.status!=='approved'||!current?.capabilities.dataPlaneVerified) throw new PlatformError(403,'TENANT_SUSPENDED','此商家尚未開放或已停用。');
        if (current.features?.[body.feature]!==true) throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未核准。');
        const route=current.moduleLine?.[body.feature]?.notifications?.[body.purpose];
        if(route?.mode==='disabled')throw new PlatformError(409,'NOTIFICATION_DISABLED','請先啟用此用途通知。');
        if(route?.mode!=='custom' && !(current.moduleLine?.[body.feature] ? current.moduleLine[body.feature].credentialsConfigured : current.credentialsConfigured))
          throw new PlatformError(409,'NOTIFICATION_NOT_CONFIGURED','請先儲存本模組 Messaging API Channel 與完整憑證，並驗證通知通道。');
        const hash=await payloadHash({feature:body.feature,purpose:body.purpose,expectedVersion:body.expectedVersion});
        const args={p_actor:actor,p_feature:body.feature,p_purpose:body.purpose,p_expected_version:body.expectedVersion,p_request_id:body.requestId,p_payload_hash:hash};
        const claim=await merchantWrite('platform_notification_test',args,workspace);if(claim.error)throw databaseError(claim.error);
        if(claim.data?.state==='accepted')return json({ok:true,data:claim.data});
        const custom=route?.mode==='custom';
        const stored=custom?await db.rpc('platform_notification_credentials',{p_tenant_id:current.id,p_feature:body.feature}):await moduleCredentials(current,body.feature);
        if(stored.error)throw databaseError(stored.error);
        const secret=custom?stored.data?.[body.purpose]:stored.data;
        if(!secret?.envelope)throw new PlatformError(409,'NOTIFICATION_NOT_CONFIGURED','請先儲存本模組或獨立通知憑證。');
        const credentials=await openCredentials(custom?current.id+':'+body.feature+':notify:'+body.purpose:secret.scope==='module'?current.id+':'+body.feature:current.id,secret.envelope,await encryptionKey());
        const channel=custom?route.channelId:(current.moduleLine?.[body.feature]?.line||current.line)?.messagingChannelId;
        await verifyNotificationToken(credentials.channelAccessToken,channel,fetchImpl);
        let remote;
        try { remote=await fetchImpl('https://api.line.me/v2/bot/message/push',{method:'POST',signal:AbortSignal.timeout(8000),
          headers:{'Content-Type':'application/json',Authorization:'Bearer '+credentials.channelAccessToken,'X-Line-Retry-Key':body.requestId},
          body:JSON.stringify({to:actor,messages:[{type:'text',text:'【通知通道測試】'+FEATURES[body.feature]+'｜'+(body.purpose==='admin'?'管理員':'會員')+'通知連線測試。此訊息僅傳給操作中的管理員。'}]})}); }
        catch {throw new PlatformError(503,'LINE_NOTIFICATION_UNCERTAIN','無法確認 LINE 是否已接收，請重試相同測試操作。');}
        const accepted=remote.ok||(remote.status===409&&Boolean(remote.headers.get('x-line-accepted-request-id')));
        const result={state:accepted?'accepted':'failed',status:remote.status,requestId:remote.headers.get('x-line-request-id')||''};
        const finish=await merchantWrite('platform_notification_test',{...args,p_result:result},workspace);if(finish.error)throw databaseError(finish.error);
        if(!accepted)throw new PlatformError(remote.status>=500||remote.status===429?503:400,'LINE_NOTIFICATION_FAILED','LINE 未接收測試通知。請確認已加入該官方帳號好友、Channel 位於相同 Provider，並檢查訊息額度。');
        return json({ok:true,data:result});
      }
      if (body.action === 'platform.notifications.save') {
        validateNotificationRoute(body);
        if (!uuid.test(body.requestId || '') || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)
          throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼或資料版本不正確。');
        const workspace = await mine(), current = workspace.tenant;
        if (workspace.application?.status !== 'approved' || !current) throw new PlatformError(403,'PLATFORM_APPLICATION_NOT_APPROVED','請先等待總管理員核准。');
        if (!current.capabilities.dataPlaneVerified) throw new PlatformError(403,'TENANT_SUSPENDED','此商家已停用或使用期限已到。');
        if (current.features?.[body.feature] !== true) throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未核准。');
        const hash = await payloadHash({feature:body.feature,purpose:body.purpose,mode:body.mode,expectedVersion:body.expectedVersion,
          channel:body.mode==='custom'?body.messagingChannelId:null,token:body.mode==='custom'?body.channelAccessToken:null});
        if(body.mode!=='disabled'){
          const replay=await configurationReplay(workspace,body.feature,'notification:'+body.feature+':'+body.purpose,hash);
          if(replay)return json({ok:true,data:{tenant:publicTenant(replay)}});
        }
        let encrypted = null, inheritedChannel = null;
        if (body.mode === 'inherit') {
          const stored=await moduleCredentials(current,body.feature);
          if(stored.error)throw databaseError(stored.error);
          inheritedChannel=(current.moduleLine?.[body.feature]?.line || current.line)?.messagingChannelId;
          if(!stored.data?.envelope || !/^\d{5,30}$/.test(inheritedChannel || ''))
            throw new PlatformError(409,'NOTIFICATION_NOT_CONFIGURED','請先儲存本模組 Messaging API Channel 與完整憑證，並驗證通知通道。');
          const credentials=await openCredentials(stored.data.scope==='module'?current.id+':'+body.feature:current.id,stored.data.envelope,await encryptionKey());
          await verifyNotificationToken(credentials.channelAccessToken,inheritedChannel,fetchImpl);
        }
        if (body.mode === 'custom') {
          await verifyNotificationToken(body.channelAccessToken,body.messagingChannelId,fetchImpl);
          encrypted = await sealCredentials(current.id+':'+body.feature+':notify:'+body.purpose,
            {channelAccessToken:body.channelAccessToken},await encryptionKey());
        }
        const result = await merchantWrite('platform_save_notification_route',{p_actor:actor,p_feature:body.feature,p_purpose:body.purpose,p_mode:body.mode,
          p_expected_version:body.expectedVersion,p_request_id:body.requestId,p_payload_hash:hash,
          p_channel_id:body.mode==='custom'?body.messagingChannelId:inheritedChannel,p_envelope:encrypted},workspace);
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{tenant:publicTenant(result.data)}});
      }
      if (body.action === 'platform.line.save') {
        if (!uuid.test(body.requestId || '') || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)
          throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼或資料版本不正確。');
        const workspace = await mine();
        if (workspace.application?.status !== 'approved' || !workspace.tenant)
          throw new PlatformError(403,'PLATFORM_APPLICATION_NOT_APPROVED','請先等待總管理員核准。');
        if (workspace.tenant.status === 'suspended')
          throw new PlatformError(403,'TENANT_SUSPENDED','此商家已被停用。');
        if (workspace.tenant.expired)
          throw new PlatformError(403,'TENANT_EXPIRED','使用期限已到，請聯絡總管理員。');
        const current = workspace.tenant;
        if (body.feature !== undefined && current.moduleLine !== undefined) {
          const key={membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'}[body.feature];
          if(!key || current.features[body.feature]!==true)throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未核准。');
          for(const other of ['memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'])if(other!==key && Object.hasOwn(body.line||{},other) && String(body.line[other]??'')!==String(current.line?.[other]??''))throw new PlatformError(400,'LINE_FEATURE_SCOPE','請只修改本功能的 LIFF 設定。');
          for(const name of ['adminChannelId','adminLiffId'])if(current.line?.[name] && body.line?.[name]!==current.line[name])
            throw new PlatformError(400,'LINE_ADMIN_IDENTITY_IMMUTABLE','管理員登入由商家共用；功能頁只能修改該功能的用戶入口與通知設定。');
          const line=Object.fromEntries(['adminChannelId','memberChannelId','messagingChannelId','adminLiffId',key].map(k=>[k,body.line?.[k]||'']));
          const validated=validateTenant({name:current.name,slug:current.slug,ownerLineUserId:current.ownerLineUserId,
            features:current.features,line,credentials:body.credentials},false,{allowIncompleteFeatureLiffs:true,liffFeature:body.feature});
          const scopedLine=Object.fromEntries(Object.keys(line).map(k=>[k,validated.line[k]]));
          const hash=await payloadHash({feature:body.feature,expectedVersion:body.expectedVersion,line:scopedLine,credentials:validated.credentials});
          if(validated.credentials.channelAccessToken){
            const replay=await configurationReplay(workspace,body.feature,'module_line:'+body.feature,hash);
            if(replay)return json({ok:true,data:{tenant:publicTenant(replay)}});
            await verifyNotificationToken(validated.credentials.channelAccessToken,scopedLine.messagingChannelId,fetchImpl);
          }
          const encrypted=validated.credentials.channelAccessToken?await sealCredentials(current.id+':'+body.feature,validated.credentials,await encryptionKey()):null;
          const result=await merchantWrite('platform_save_module_line',{p_actor:actor,p_feature:body.feature,p_expected_version:body.expectedVersion,
            p_request_id:body.requestId,p_payload_hash:hash,p_line:scopedLine,p_secrets:encrypted},workspace);
          if(result.error)throw databaseError(result.error);
          return json({ok:true,data:{tenant:publicTenant(result.data)}});
        }
        if (body.feature !== undefined) {
          const key = {membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'}[body.feature];
          if (!key || current.features[body.feature] !== true)
            throw new PlatformError(403,'FEATURE_DISABLED','此功能尚未核准，無法修改 LINE 設定。');
          for (const other of ['memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'])
            if (other !== key && String(body.line?.[other] ?? '') !== String(current.line?.[other] ?? ''))
              throw new PlatformError(400,'LINE_FEATURE_SCOPE','請只修改本功能的 LIFF 設定。');
        }
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
        const result = await merchantWrite('platform_save_my_line',{
          p_actor:actor,p_expected_version:body.expectedVersion,p_request_id:body.requestId,
          p_payload_hash:hash,p_line:validated.line,p_secrets:encrypted,
        },workspace);
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{tenant:publicTenant(result.data)}});
      }
      // Platform-only LINE verification succeeded. Persist a pending identity
      // independently of authorization; repeated visits never grant rights.
      if (body.action === 'platform.bootstrap') {
        const registration = await db.rpc('platform_record_access_request',{
          p_actor:actor,p_display_name:identity.displayName || 'LINE 使用者',
        });
        if (registration.error) throw databaseError(registration.error);
      }
      // All control-plane operations require the current super-admin database record.
      const auth = await db.rpc('platform_is_super_admin',{p_actor:actor});
      if (auth.error) throw databaseError(auth.error);
      if (auth.data !== true) throw new PlatformError(403,'PLATFORM_ADMIN_REQUIRED','僅總管理員可管理商家。');
      if (body.action === 'platform.merchant.review') {
        const reason = body.reason === undefined ? '' : body.reason;
        const grants = body.features;
        const validGrants = grants && typeof grants === 'object' && !Array.isArray(grants)
          && Object.keys(grants).length === Object.keys(FEATURES).length
          && Object.keys(FEATURES).every(key => Object.hasOwn(grants,key) && typeof grants[key] === 'boolean');
        if (!validId(body.requestId) || !validId(body.applicationId) || !validVersion(body.expectedVersion)
          || !['approved','rejected'].includes(body.decision)
          || typeof reason !== 'string' || Array.from(reason.trim()).length > 500
          || (body.decision === 'approved' ? !validGrants : !reason.trim() || grants != null))
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請確認商家申請、資料版本、審核理由與八項功能。');
        const result = await db.rpc('platform_review_merchant_application',{
          p_actor:actor,p_application_id:body.applicationId,p_expected_version:body.expectedVersion,
          p_decision:body.decision,p_reason:reason.trim(),p_features:grants ?? null,p_request_id:body.requestId,
        });
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{application:merchantResponse(result.data)}});
      }
      if (body.action === 'platform.qualification.list') {
        const result = await db.rpc('platform_list_admin_qualifications',{p_actor:actor});
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{qualifications:result.data || []}});
      }
      if (body.action === 'platform.qualification.review') {
        const reason = body.reason === undefined ? '' : body.reason;
        if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)
          || typeof body.qualificationId !== 'string' || !uuid.test(body.qualificationId)
          || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || body.expectedVersion > 2147483647
          || !['approved','rejected','suspended'].includes(body.decision)
          || typeof reason !== 'string' || Array.from(reason.trim()).length > 500
          || (['rejected','suspended'].includes(body.decision) && !reason.trim()))
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請確認申請、資料版本、審核結果與理由。');
        const result = await db.rpc('platform_review_admin_qualification',{
          p_actor:actor,p_qualification_id:body.qualificationId,p_expected_version:body.expectedVersion,
          p_decision:body.decision,p_reason:reason.trim(),p_request_id:body.requestId,
        });
        if (result.error) throw databaseError(result.error);
        return json({ok:true,data:{qualification:result.data}});
      }
      if (body.action === 'platform.bootstrap') {
        const [tenants,applications] = await Promise.all([
          db.rpc('platform_list_tenants',{p_actor:actor}),
          db.rpc('platform_list_applications',{p_actor:actor}),
        ]);
        if (tenants.error) throw databaseError(tenants.error);
        if (applications.error) throw databaseError(applications.error);
        return json({ok:true,data:{profile:{displayName:identity.displayName},
          features:FEATURES,tenants:(tenants.data || []).map(publicTenant),
          applications:(applications.data || []).map(application => ({...merchantResponse(application),
            applicantLineUserId:application.applicantLineUserId,tenantId:application.tenantId}))}});
      }
      // This API never approves Platform operators: the Supabase owner edits
      // platform_private.super_admins.enabled in the Table Editor.
      if (body.action === 'platform.operator.review') {
        throw new PlatformError(403,'PLATFORM_SUPABASE_ONLY_APPROVAL',
          'Platform 管理權限只能由 Supabase 管理者修改。');
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
      if (body.action === 'platform.tenant.features.save') {
        if (!uuid.test(body.requestId || '') || !uuid.test(body.tenantId || '')
          || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','商家 ID、版本或操作識別碼不正確。');
        const features=body.features;
        if (!features || typeof features !== 'object' || Array.isArray(features)
          || Object.keys(features).length !== Object.keys(FEATURES).length
          || Object.keys(FEATURES).some(key=>typeof features[key]!=='boolean')
          || Object.keys(features).some(key=>!Object.hasOwn(FEATURES,key)))
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請逐項勾選有效功能。');
        const hash=await payloadHash({tenantId:body.tenantId,expectedVersion:body.expectedVersion,features});
        const result=await db.rpc('platform_update_tenant_features',{
          p_actor:actor,p_tenant_id:body.tenantId,p_expected_version:body.expectedVersion,
          p_features:features,p_request_id:body.requestId,p_payload_hash:hash,
        });
        if(result.error)throw databaseError(result.error);
        return json({ok:true,data:{tenant:publicTenant(result.data)}});
      }
      // Deprecated root writes cannot bypass the applicant/approval workflow.
      if (body.action === 'platform.tenant.save')
        throw new PlatformError(410,'PLATFORM_LEGACY_WRITE_DISABLED','請由一般管理員申請；總管理員只能核准與勾選功能。');
      if (['platform.tenant.resume','platform.tenant.expiry.save'].includes(body.action)) {
        if (!uuid.test(body.requestId || '') || !uuid.test(body.tenantId || '')
          || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)
          throw new PlatformError(400,'PLATFORM_INVALID_INPUT','商家 ID、版本或操作識別碼不正確。');
        let change={status:'active'};
        if(body.action==='platform.tenant.expiry.save') {
          try { change={expiresAt:normalizeExpiry(body.expiresAt)}; }
          catch { throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請提供有效期限（含時區），或選擇無到期日。'); }
        }
        const result=await db.rpc('platform_update_tenant_access',{p_actor:actor,p_tenant_id:body.tenantId,
          p_expected_version:body.expectedVersion,p_request_id:body.requestId,p_change:change});
        if(result.error)throw databaseError(result.error);
        return json({ok:true,data:{tenant:publicTenant(result.data)}});
      }
      if (body.action !== 'platform.tenant.suspend')
        throw new PlatformError(404,'ACTION_NOT_FOUND','不支援的總管理員操作。');
      if (!uuid.test(body.requestId || '') || !uuid.test(body.tenantId || ''))
        throw new PlatformError(400,'INVALID_REQUEST_ID','操作識別碼格式不正確。');
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)
        throw new PlatformError(400,'INVALID_VERSION','資料版本格式不正確。');
      const rpc = await db.rpc('platform_suspend_tenant',{p_actor:actor,p_tenant_id:body.tenantId,
        p_expected_version:body.expectedVersion,p_request_id:body.requestId});
      if (rpc.error) throw databaseError(rpc.error);
      return json({ok:true,data:{tenant:publicTenant(rpc.data)}});
    } catch (error) {
      let safe = error instanceof PlatformError ? error : new PlatformError(503,'PLATFORM_UNAVAILABLE','總管理員服務暫時無法使用。');
      if(webhookActor && safe.status===404)safe=new PlatformError(403,'BUSINESS_FORBIDDEN','無法存取此商家的連線診斷。');
      if(webhookActor && [401,403].includes(safe.status)){
        const audit=await db.rpc('platform_line_webhook_denied',{p_actor:webhookActor});
        if(audit.error)return json({ok:false,error:{code:'PLATFORM_DATABASE_UNAVAILABLE',message:'目前無法記錄存取檢查，請稍後再試。'}},503);
      }
      // Never return raw database, LINE provider or encryption errors.
      return json({ok:false,error:{code:safe.code,message:safe.message}},safe.status);
    }
  };
}
