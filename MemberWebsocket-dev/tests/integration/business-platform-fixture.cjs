const fixture=require('./business-runtime-fixture.cjs');
const {shared,key}=require('./platform-fixture.cjs');
module.exports=async()=>{
 const h=await fixture();
 // This cross-module browser fixture uses the production platform handler.
 // Apply the new platform registration migration to its physical SQL DB too.
 const fs=require('node:fs'),path=require('node:path');
 await h.db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261023224500_platform_access_registration_and_review.sql'),'utf8'));
 await h.db.exec('create schema if not exists maintenance');
 await h.db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261023235000_platform_super_admins_supabase_managed.sql'),'utf8'));
 const migrationDir=path.join(__dirname,'../../supabase/migrations');
 for(const suffix of ['_admin_qualification_foundation.sql','_merchant_application_multi_owner.sql','_merchant_explicit_context.sql','_line_capabilities.sql']){
  const file=fs.readdirSync(migrationDir).find(name=>name.endsWith(suffix));
  if(!file)throw Error('MISSING_COORDINATED_MERCHANT_MIGRATION');
  await h.db.exec(fs.readFileSync(path.join(migrationDir,file),'utf8'));
 }
 // Existing business tests still provision an approved synthetic shop through
 // this helper. Use the real coordinated qualification + merchant transaction.
 h.approve=async(actor,slug,features=Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(k=>[k,true])))=>{
  const one=async(name,args)=>(await h.db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  let q=await one('platform_submit_admin_qualification',[actor,slug,crypto.randomUUID()]);
  if(q.status==='pending')await one('platform_review_admin_qualification',[h.root,q.id,q.version,'approved','',crypto.randomUUID()]);
  const a=await one('platform_submit_merchant_application',[actor,slug,slug,crypto.randomUUID(),null,null]);
  return(await one('platform_review_merchant_application',[h.root,a.id,a.version,'approved','',features,crypto.randomUUID()])).tenant;
 };
 const allowedOrigins=new Set(['https://allowed.test']);
 const rpc=async(name,params={})=>{
  if(!/^(platform_[a-z0-9_]+|consume_api_rate_limit)$/.test(name))throw Error('Unknown RPC '+name);
  try{
   const entries=Object.entries(params),sql=`select public.${name}(${entries.map(([key],i)=>key+'=>$'+(i+1)).join(',')}) result`;
   const rows=await h.db.transaction(async tx=>{await tx.exec('set local role service_role');return(await tx.query(sql,entries.map(([,value])=>value))).rows;});
   return{data:['platform_list_tenants','platform_list_applications','platform_list_access_requests','platform_list_admin_qualifications','platform_my_merchant_applications','platform_active_businesses'].includes(name)?rows.map(r=>r.result):rows[0]?.result,error:null};
  }catch(error){return{data:null,error};}
 };
 const {createPlatformHandler}=await shared('platform-handler.mjs'),{verifyPlatformIdToken,verifyMerchantAdminIdToken}=await shared('platform-auth.mjs');
 const provider=(channel)=>async(_url,options)=>{
  const token=options.body.get('id_token'),sub=token==='root'?h.root:token==='manager'?'U'+'2'.repeat(32):'';
  return new Response(JSON.stringify({sub,aud:channel,name:token==='manager'?'商家管理員':'總管理員',iss:'https://access.line.me',iat:Math.floor(Date.now()/1000)-10,exp:Math.floor(Date.now()/1000)+300}),{status:sub?200:400});
 };
 const handler=createPlatformHandler({db:{rpc},allowedOrigins,encryptionKey:()=>key,fetchImpl:async url=>{
  if(url!=='https://api.line.me/v2/oauth/verify')throw Error('UNEXPECTED_LINE_PROVIDER_CALL');
  return new Response(JSON.stringify({client_id:'2010123456',expires_in:3600}));
 },verifyIdentity:idToken=>verifyPlatformIdToken({idToken,fetchImpl:provider('2012065297')}),verifyApplicantIdentity:idToken=>verifyMerchantAdminIdToken({idToken,fetchImpl:provider('2010791619')})});
 const call=async(body,token='root')=>{const res=await handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({...body,idToken:token})}));return{status:res.status,body:await res.json()};};
 return{...h,rpc,allowedOrigins,handler,call};
};
