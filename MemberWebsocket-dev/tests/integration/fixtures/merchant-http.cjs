const path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {setup:database,root,owner,other,features}=require('./merchant-applications.cjs');
const shared=name=>import(pathToFileURL(path.resolve(__dirname,'../../../supabase/functions/_shared',name)));
async function setup({origins=[],context=true,rate=()=>({data:true,error:null})}={}){
 const h=await database();
 try{
  if(context){
   const dir=path.resolve(__dirname,'../../../supabase/migrations');
   const names=fs.readdirSync(dir).filter(n=>n.endsWith('_merchant_explicit_context.sql'));
   if(names.length!==1)throw Error('ONE_MERCHANT_CONTEXT_MIGRATION_REQUIRED');
   await h.db.exec(fs.readFileSync(path.join(dir,names[0]),'utf8'));
  }
  const {createPlatformHandler}=await shared('platform-handler.mjs');
  const {verifyMerchantAdminIdToken,verifyPlatformIdToken}=await shared('platform-auth.mjs');
  const key=Buffer.alloc(32,7).toString('base64');
  h.allowedOrigins=new Set(['https://allowed.test',...origins]);h.providerCalls=[];h.rpcCalls=[];
  h.issuedAtMs=()=>Math.floor(Date.now()/1000)*1000;
  const transport=async(input,options={})=>{
   const url=String(input);h.providerCalls.push({url,body:options.body});
   if(url.endsWith('/oauth2/v2.1/verify')){
    const token=options.body.get('id_token'),channel=options.body.get('client_id');
    const sub=token==='manager'?owner:token==='other'?other:token==='root'?root:'';
    const iat=h.issuedAtMs(token)/1000;
    return new Response(JSON.stringify({sub,name:token==='manager'?'商家管理員':'總管理員',aud:channel,iss:'https://access.line.me',iat,exp:Date.now()/1000+300}),{status:sub?200:400});
   }
   if(url.endsWith('/v2/bot/info'))return new Response(JSON.stringify({userId:'U'+'e'.repeat(32),basicId:'@synthetic'}));
   if(url.endsWith('/oauth2/v2.1/verify'))throw Error('UNEXPECTED_VERIFY');
   if(url.includes('/oauth/verify'))return new Response(JSON.stringify({client_id:'2010123456',expires_in:3600}));
   if(url.endsWith('/v2/bot/message/push'))return new Response('{}',{headers:{'x-line-request-id':'synthetic-only'}});
   throw Error('UNEXPECTED_EXTERNAL_TRANSPORT '+url);
  };
  const rpc=async(name,p)=>{
   if(name==='consume_api_rate_limit')return rate(p);
   h.rpcCalls.push({name,p});
   if(!/^platform_[a-z0-9_]+$/.test(name))throw Error('INVALID_FIXTURE_RPC');
   const candidates=(await h.db.query(`select proargnames,proretset from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=$1`,[name])).rows;
   const candidate=candidates.find(c=>Object.keys(p).every(k=>c.proargnames?.includes(k)));
   if(!candidate)return{data:null,error:{message:'FIXTURE_RPC_NOT_FOUND'}};
   try{const rows=await h.rows(name,candidate.proargnames.map(k=>p[k]??null));return{data:candidate.proretset?rows.map(r=>r.result):rows[0]?.result,error:null};}
   catch(error){return{data:null,error};}
  };
  h.rpc=rpc;h.features=features;h.root=root;h.owner=owner;h.other=other;
  h.handler=createPlatformHandler({db:{rpc},allowedOrigins:h.allowedOrigins,encryptionKey:()=>key,fetchImpl:transport,
   verifyApplicantIdentity:(idToken,channel)=>verifyMerchantAdminIdToken({idToken,fetchImpl:transport},channel),
   verifyIdentity:idToken=>verifyPlatformIdToken({idToken,fetchImpl:transport})});
  h.platformCall=async(body,token='manager')=>{
   const response=await h.handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({...body,idToken:token})}));
   return{status:response.status,body:await response.json()};
  };
  return h;
 }catch(error){await h.db.close();throw error;}
}
module.exports={setup,root,owner,other,features};
