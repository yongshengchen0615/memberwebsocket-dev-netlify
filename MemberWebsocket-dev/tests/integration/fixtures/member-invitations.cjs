const fs=require('node:fs'),path=require('node:path');
const runtime=require('../business-runtime-fixture.cjs');
const migrations=path.resolve(__dirname,'../../../supabase/migrations');
const migration=()=>fs.readFileSync(path.join(migrations,fs.readdirSync(migrations).find(n=>n.endsWith('_member_invitations.sql'))),'utf8');
async function setup(options={}){
 const h=await runtime(options);
 try{
  h.old=await h.approve('U'+'2'.repeat(32),'invitation-old');
  await h.db.exec(migration());
  h.fresh=await h.approve('U'+'3'.repeat(32),'invitation-new');
  for(const t of [h.old,h.fresh]){
   await h.db.query("update platform_private.tenants set status='active',credentials_configured=true,isolation_verified_at=now(),isolation_version='business-v1-20261019',expires_at=now()+interval '30 days' where id=$1",[t.id]);
   t.terms=(await h.db.query(`insert into ${t.runtime_schema}.membership_terms(version,title,body,status,required,effective_at,activated_at,created_by,updated_by) values('inv-v1','Synthetic','Synthetic','active',true,now()-interval '1 day',now(),'fixture','fixture') returning id`)).rows[0].id;
  }
  h.rpc=async(t,name,args=[],client=h.db)=>(await client.query(`select ${t.runtime_schema}.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  h.pending=async(t,{test=false}={})=>{
   const user='U'+crypto.randomUUID().replaceAll('-','');
   const m=(await h.db.query(`insert into ${t.runtime_schema}.members(line_user_id,member_code,status,membership_status,is_test_account) values($1,$2,'active','pending',$3) returning *`,[user,'M'+crypto.randomUUID().replaceAll('-','').slice(0,20),test])).rows[0];return m;
  };
  h.accept=(t,m,client=h.db)=>h.rpc(t,'accept_membership_terms_api',[JSON.stringify({lineUserId:m.line_user_id,termsId:t.terms,termsVersion:'inv-v1',accepted:true,birthday:'1990-01-01',phone:'+886912345678',surname:'林',salutation:'mr'})],client);
  h.active=async(t)=>{const m=await h.pending(t);await h.accept(t,m);return(await h.db.query(`select * from ${t.runtime_schema}.members where id=$1`,[m.id])).rows[0];};
  h.source=async(t,quota=0)=>{
   await h.db.exec(`update ${t.runtime_schema}.event_tickets set status='draft' where ticket_type='referral' and referral_source_event_ticket_id is null`);
   return(await h.db.query(`insert into ${t.runtime_schema}.event_tickets(event_ticket_id,title,ticket_type,status,quota,allowed_tier_keys,ends_on,created_by,updated_by) values($1,'Invitation reward','referral','active',$2,array['general','silver','gold','platinum'],current_date+7,'fixture','fixture') returning id`,['SOURCE-'+crypto.randomUUID(),quota])).rows[0].id;
  };
  h.hash=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  h.token=async(t,m)=>{const hash=h.hash();const data=await h.rpc(t,'member_invitation_create',[m.line_user_id,hash]);return{hash,...data};};
  return h;
 }catch(e){await h.db.close();throw e;}
}
module.exports={setup,migration};
