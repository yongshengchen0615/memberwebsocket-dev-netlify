const fs=require('node:fs'),path=require('node:path');
const runtime=require('../business-runtime-fixture.cjs');
const dir=path.resolve(__dirname,'../../../supabase/migrations');
const qualification=fs.readFileSync(path.join(dir,'20261023121931_admin_qualification_foundation.sql'),'utf8');
const merchantFile=fs.readdirSync(dir).filter(n=>n.endsWith('_merchant_application_multi_owner.sql'));
if(merchantFile.length!==1)throw Error('ONE_MERCHANT_MIGRATION_REQUIRED');
const merchant=fs.readFileSync(path.join(dir,merchantFile[0]),'utf8');
const root='U'+'1'.repeat(32),owner='U'+'2'.repeat(32),other='U'+'3'.repeat(32);
const features=only=>Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(k=>[k,only.includes(k)]));
async function setup({database,before,apply=true}={}){
 const h=await runtime(database||{}),db=h.db;
 try{
  if(before)await before(h);
  await db.exec('create schema if not exists maintenance');
  for(const n of ['20261023224500_platform_access_registration_and_review.sql','20261023235000_platform_super_admins_supabase_managed.sql'])await db.exec(fs.readFileSync(path.join(dir,n),'utf8'));
  await db.exec(qualification);if(apply)await db.exec(merchant);
  const call=async(name,args=[],role='service_role')=>{
   if(!/^platform_[a-z0-9_]+$/.test(name)||!['service_role','anon','authenticated'].includes(role))throw Error('INVALID_TEST_CALL');
   const sql=`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`;
   // Physical harness has a dedicated administrative connection. Every call
   // resets its role even when PostgreSQL rejects the statement.
   await db.exec('set role '+role);
   try{return(await db.query(sql,args)).rows;}finally{await db.exec('reset role');}
  };
  const one=async(n,a,role)=>(await call(n,a,role))[0]?.result;
  h.call=one;h.rows=call;
  h.qualify=async(actor=owner)=>{
   let q=await one('platform_submit_admin_qualification',[actor,'Synthetic owner',crypto.randomUUID()]);
   if(q.status==='pending')q=await one('platform_review_admin_qualification',[root,q.id,q.version,'approved','',crypto.randomUUID()]);
   return q;
  };
  h.submit=(actor=owner,slug='merchant-b',name='Merchant B',request=crypto.randomUUID(),id=null,version=null)=>one('platform_submit_merchant_application',[actor,name,slug,request,id,version]);
  h.get=(id,actor=owner)=>one('platform_get_merchant_application',[actor,id]);
  h.list=async(actor=owner)=>(await call('platform_my_merchant_applications',[actor])).map(r=>r.result);
  h.review=(a,decision='approved',grants=features(['points']),reason='',request=crypto.randomUUID(),actor=root)=>one('platform_review_merchant_application',[actor,a.id,a.version,decision,reason,grants,request]);
  h.count=async(table)=>(await db.query('select count(*)::int n from platform_private.'+table)).rows[0].n;
  return h;
 }catch(error){await db.close();throw error;}
}
module.exports={setup,qualification,merchant,root,owner,other,features};
