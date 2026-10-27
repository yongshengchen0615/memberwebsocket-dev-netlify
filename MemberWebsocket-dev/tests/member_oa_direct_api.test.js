const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('./helpers/edge-test-fs.cjs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const lineUser='U'+'1'.repeat(32),channel='2010787602';
const tenant={id:'synthetic-shop-a',features:{membership:true},line_config:{memberChannelId:channel,memberLiffId:channel+'-synthetic'}};
const bindings=JSON.stringify([{tenantId:tenant.id,memberLoginChannelId:channel,memberOaId:'@synthetic_shop'}]);

async function harness(slug,options={}){
 const {requireMemberOaBeforeActivation}=await import('../supabase/functions/_shared/member-oa-registration-gate.mjs');
 const member={id:'member-a',line_user_id:lineUser,member_code:'MA',display_name:'Synthetic',status:'active',membership_status:'pending',created_at:'2026-01-01T00:00:00Z'};
 const terms={id:'terms-a',version:'v1',status:'active',scope:'production',required:true,effective_at:'2020-01-01T00:00:00Z',activated_at:'2020-01-01T00:00:00Z',reconsent_existing:false};
 let consent=false,endpoint;const calls=[];
 const db={
  async rpc(name,args){
   if(name==='consume_api_rate_limit')return{data:options.rateLimit!==false,error:null};
   if(name==='member_service_minute_totals')return{data:[{member_id:member.id,total_minutes:0}],error:null};
   assert.ok(['accept_membership_terms','accept_membership_terms_api'].includes(name),name);
   const payload=args.p_payload||{lineUserId:args.p_line_user_id,birthday:args.p_birthday,phone:args.p_phone,surname:args.p_surname,salutation:args.p_salutation};
   assert.equal(payload.lineUserId,lineUser,'activation must use the server identity');
   consent=true;Object.assign(member,{membership_status:'active',birthday:payload.birthday,phone:payload.phone,surname:payload.surname,salutation:payload.salutation});
   return{data:true,error:null};
  },
  from(table){
   let row=table==='members'?member:table==='membership_terms'?terms:table==='test_mode_settings'?{maintenance_enabled:false}:null;
   assert.ok(['members','membership_terms','membership_consents','membership_tier_settings','test_mode_settings','audit_logs','realtime_events'].includes(table),table);
   const q={select(){return q;},eq(){return q;},order(){return Promise.resolve({data:[],error:null});},
    maybeSingle(){return Promise.resolve({data:row,error:null});},single(){return Promise.resolve({data:row,error:null});},
    update(patch){Object.assign(member,patch);row=member;return q;},insert(){return q;},then(resolve,reject){return Promise.resolve({data:row,error:null}).then(resolve,reject);}};
   return q;
  },
 };
 const fetchLine=async(url)=>{
  const address=String(url);calls.push(address.split('?')[0]);
  if(options.networkError)throw new Error('synthetic transport failure');
  if(options.providerStatus)return new Response('{}',{status:options.providerStatus});
  if(address.includes('/verify'))return Response.json({client_id:options.tokenChannel||channel,scope:'profile openid',expires_in:3600});
  if(address.endsWith('/profile'))return Response.json({userId:options.tokenUser||lineUser});
  if(address.endsWith('/status'))return Response.json({friendFlag:options.friend!==false});
  assert.fail('Unexpected LINE endpoint');
 };
 const environment={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',LINE_MEMBER_CHANNEL_ID:channel,MEMBER_OA_VERIFIED_LINKS_JSON:options.missingBinding?'':bindings};
 const context=vm.createContext({
  Deno:{env:{get:key=>environment[key]||''},serve(fn){endpoint=fn;}},
  businessContext:()=>options.wrongTenant?{...tenant,id:'synthetic-shop-b'}:tenant,
  businessHandler:(_name,fn)=>fn,createClient:()=>db,readJsonObject:req=>req.json(),
  resolveUserTestIdentity:async()=>null,TestModeAuthError:class extends Error{},
  verifyLineIdTokenContract:async args=>{if(args.idToken!=='synthetic-verified-id')throw args.createError(401,'AUTH_INVALID','Invalid synthetic identity');return{lineUserId:lineUser,displayName:'Synthetic',issuedAtMs:Date.now()};},
  requireMemberOaBeforeActivation:args=>requireMemberOaBeforeActivation({...args,fetchImpl:fetchLine}),
  bookingTicketUsageError:()=>null,crypto:require('node:crypto').webcrypto,TextEncoder,Date,Response,console,
 });
 let source=fs.readFileSync(path.join(__dirname,'../supabase/functions',slug,'index.ts'),'utf8').replace(/^import .*\n/gm,'');
 if(slug==='api')source=source.replace('export default { fetch:','globalThis.apiExport = { fetch:');
 vm.runInContext(stripTypeScriptTypes(source),context);
 if(slug==='api')endpoint=context.apiExport.fetch;
 return{member,calls,hasConsent:()=>consent,async call(patch={}){
  const response=await endpoint(new Request('https://example.invalid',{method:'POST',headers:{'content-type':'application/json',origin:'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app'},body:JSON.stringify({action:'user.member.profile.save',clientType:'member',idToken:'synthetic-verified-id',lineAccessToken:'synthetic-access-token',birthday:'1990-01-01',phone:'+886912345678',surname:'林',salutation:'mr',termsId:terms.id,termsVersion:terms.version,accepted:true,...patch})}));
  return{status:response.status,body:await response.json()};
 }};
}

for(const slug of ['member-profile-api','api']){
 for(const [label,options,status,code]of [
  ['forged friendFlag',{friend:false},403,'MEMBER_OA_FRIENDSHIP_REQUIRED'],
  ['wrong access-token channel',{tokenChannel:'2099999999'},401,'LINE_CHANNEL_OR_SCOPE_MISMATCH'],
  ['wrong access-token user',{tokenUser:'U'+'2'.repeat(32)},401,'LINE_IDENTITY_MISMATCH'],
  ['cross-shop binding',{wrongTenant:true},503,'MEMBER_OA_CONFIG_INCOMPLETE'],
  ['missing server binding',{missingBinding:true},503,'MEMBER_OA_CONFIG_INCOMPLETE'],
  ['LINE rate limit',{providerStatus:429},503,'LINE_FRIENDSHIP_UNAVAILABLE'],
  ['LINE unavailable',{providerStatus:503},503,'LINE_FRIENDSHIP_UNAVAILABLE'],
  ['LINE transport timeout',{networkError:true},503,'LINE_FRIENDSHIP_UNAVAILABLE'],
  ['application rate limit',{rateLimit:false},429,'RATE_LIMITED'],
 ])test(`${slug}: direct HTTP ${label} leaves membership pending and consent absent`,async()=>{
  const h=await harness(slug,options),result=await h.call({friendFlag:true,lineUserId:'U'+'f'.repeat(32),business:'other-shop'});
  assert.equal(result.status,status,JSON.stringify(result.body));assert.equal(result.body.error.code,code);
  assert.equal(h.member.membership_status,'pending');assert.equal(h.hasConsent(),false);
  assert.doesNotMatch(JSON.stringify(result.body),/synthetic-access-token/);
 });
 test(`${slug}: direct HTTP verified member OA activates the authenticated identity`,async()=>{
  const h=await harness(slug),result=await h.call({lineUserId:'U'+'f'.repeat(32)});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(h.member.membership_status,'active');assert.equal(h.hasConsent(),true);
  assert.equal(h.member.line_user_id,lineUser);assert.equal(h.calls.length,3);
 });
}
