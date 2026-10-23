import { createClient } from "npm:@supabase/supabase-js@2.57.0";

/** SQL-only reset worker. The HTTP endpoint is NOT a public reset API:
 * it requires a fresh, one-use 256-bit job ticket minted only by the DBA.
 * Its job records are never exposed to anon/authenticated users.
 * Backups and restorability MUST have been independently verified before
 * request_full_reset_from_sql will enqueue anything.
 */
const PROJECT="dbuquirnaskrwcamdxki";
const DOMAIN="https://"+PROJECT+".supabase.co";
type Json={ [key:string]:unknown };
type Supabase=ReturnType<typeof createClient>;
const send=(body:Json,status=200)=>new Response(JSON.stringify(body),{
 status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
function configuration(){
 const url=(Deno.env.get("SUPABASE_URL")||"").replace(/\/$/,"");
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 if(url!==DOMAIN||!key)throw Error("RESET_WRONG_PROJECT_OR_NO_SERVER_KEY");
 return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
}
async function phase(db:Supabase,id:string,ticket:string,action:string,result:Json|null=null):Promise<Json>{
 const r=await db.rpc("maintenance_sql_reset_phase",{
   p_job_id:id,p_ticket:ticket,p_action:action,p_result:result
 });
 if(r.error)throw Error("RESET_"+action.toUpperCase()+"_DENIED");
 return (r.data||{}) as Json;
}
async function clearAuth(db:Supabase):Promise<void>{
 // A test project has no active managed Auth users today. Keep a strict
 // bounded loop to prevent an untrusted pagination response from hanging.
 for(let page=0;page<101;page++){
  const r=await db.auth.admin.listUsers({page:1,perPage:100});
  if(r.error)throw Error("RESET_AUTH_LIST_FAILED");
  const users=r.data?.users||[];
  if(users.length===0)return;
  for(const u of users){
   const deleted=await db.auth.admin.deleteUser(u.id,false);
   if(deleted.error)throw Error("RESET_AUTH_DELETE_FAILED");
  }
 }
 throw Error("RESET_AUTH_TOO_MANY_BATCHES");
}
async function clearStorage(db:Supabase,buckets:string[]):Promise<void>{
 for(const bucket of buckets){
  if(!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(bucket))
    throw Error("RESET_STORAGE_BUCKET_INVALID");
  const r=await db.storage.emptyBucket(bucket);
  if(r.error)throw Error("RESET_STORAGE_EMPTY_FAILED");
 }
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return send({ok:false,error:"METHOD_NOT_ALLOWED"},405);
 if(Number(req.headers.get("content-length")||"0")>2048)
   return send({ok:false,error:"REQUEST_TOO_LARGE"},413);
 let jobId="",ticket="",claimed=false;
 let db:Supabase;
 try{
  const body=await req.json();
  jobId=String(body?.job_id||"");
  ticket=String(body?.ticket||"");
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId)||
     !/^[a-f0-9]{64}$/.test(ticket))
    return send({ok:false,error:"INVALID_WORKER_REQUEST"},401);
  db=configuration();
  const claim=await db.rpc("maintenance_sql_reset_claim",{
   p_job_id:jobId,p_ticket:ticket
  });
  if(claim.error||claim.data?.accepted!==true)
    return send({ok:false,error:"UNAUTHORIZED_OR_EXPIRED_JOB"},403);
  claimed=true;
  // Disable autonomous dispatch before irreversible writes. External LINE
  // providers MUST already be isolated as part of the operator's attestation.
  await phase(db,jobId,ticket,"pause");
  const before=await phase(db,jobId,ticket,"inventory");
  const buckets=before.buckets;
  if(!Array.isArray(buckets)||buckets.some(b=>typeof b!=="string"))
    throw Error("RESET_BUCKET_INVENTORY_UNAVAILABLE");
  await clearAuth(db);
  await clearStorage(db,buckets as string[]);
  const after=await phase(db,jobId,ticket,"inventory");
  if(after.authUsers!==0||after.storageObjects!==0||after.activeCron!==0)
    throw Error("RESET_RESIDUAL_MANAGED_RESOURCES");
  const finished=await phase(db,jobId,ticket,"finish");
  if(finished.databaseReset!==true)throw Error("RESET_FINAL_RESULT_UNEXPECTED");
  return send({ok:true,jobId,state:"completed",databaseReset:true});
 }catch(error){
  const code=error instanceof Error?error.message:"RESET_UNEXPECTED_WORKER_ERROR";
  // Fail closed; never auto-resume Cron or notify LINE of stale outbox work.
  // Error logging intentionally excludes job tickets, secrets and file names.
  if(claimed){
   try{
    db=configuration();
    await phase(db,jobId,ticket,"fail",{error:code});
   }catch{ /* manual DBA investigation required */ }
  }
  return send({ok:false,jobId,state:"failed",error:code},500);
 }
});
