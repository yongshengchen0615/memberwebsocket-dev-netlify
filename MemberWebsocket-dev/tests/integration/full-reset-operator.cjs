#!/usr/bin/env node
'use strict';
// #82 SQL+Storage+Auth sandbox reset operator. Never run with site visitors.
// Requires PostgreSQL CLI 17, pinned pg client, a strong encryption key, local
// durable backup folder and project service key. No secrets are printed.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID,createHash,createCipheriv,createDecipheriv,randomBytes}=require('node:crypto');
const {Client}=require('pg');
const exec=promisify(execFile);
const PROJECT='dbuquirnaskrwcamdxki';
const CONFIRM='RESET MEMBERWEBSOCKET TEST DATA';
const sha=data=>createHash('sha256').update(data).digest('hex');
const ident=s=>'"'+s.replaceAll('"','""')+'"';
const assert=(ok,message)=>{if(!ok)throw Error(message)};
const required=(env,key)=>{const v=env[key];assert(v&&v.trim(),key+'_REQUIRED');return v.trim()};
const json=(a)=>JSON.stringify(a,null,2);
function cipher(key,plain){
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
 return Buffer.concat([Buffer.from('RST1'),iv,c.update(plain),c.final(),c.getAuthTag()]);
}
function decipher(key,blob){
 assert(blob.subarray(0,4).toString()==='RST1','INVALID_ENCRYPTED_ARCHIVE');
 const d=createDecipheriv('aes-256-gcm',key,blob.subarray(4,16));
 d.setAuthTag(blob.subarray(blob.length-16));
 return Buffer.concat([d.update(blob.subarray(16,-16)),d.final()]);
}
async function storageCall(url,key,route,{method='GET',body,contentType}={}){
 const headers={Authorization:'Bearer '+key,apikey:key};
 if(contentType)headers['Content-Type']=contentType;
 const response=await fetch(url+'/storage/v1'+route,{method,headers,body});
 if(!response.ok)throw Error('STORAGE_API_'+response.status+'_'+method);
 return response;
}
const encoded=(bucket,name)=>encodeURIComponent(bucket)+'/'+name.split('/').map(encodeURIComponent).join('/');
async function verifyStorageArchive({url,key,db,keyBytes,backupDir}){
 const {rows:objects}=await db.query('select bucket_id,name from storage.objects order by bucket_id,name');
 const names=new Set(),manifest=[];
 for(const obj of objects){
  const label=obj.bucket_id+'/'+obj.name;
  assert(!names.has(label),'STORAGE_DUPLICATE_KEY');names.add(label);
  const r=await storageCall(url,key,'/object/authenticated/'+encoded(obj.bucket_id,obj.name));
  const data=Buffer.from(await r.arrayBuffer()),digest=sha(data);
  const backupName=sha(Buffer.from(label))+'.enc';
  await fs.writeFile(path.join(backupDir,backupName),cipher(keyBytes,data),{mode:0o600});
  const roundtrip=decipher(keyBytes,await fs.readFile(path.join(backupDir,backupName)));
  assert(sha(roundtrip)===digest,'STORAGE_ENCRYPTED_BACKUP_VERIFY_FAILED');
  manifest.push({bucket:obj.bucket_id,name:obj.name,sha256:digest,bytes:data.length,backupName});
 }
 // Prove actual API restore and byte integrity in a disposable bucket. All
 // original objects remain untouched until every backup is verified.
 const temp='reset-proof-'+randomUUID().replaceAll('-','').slice(0,32);
 await storageCall(url,key,'/bucket',{method:'POST',contentType:'application/json',
   body:JSON.stringify({id:temp,name:temp,public:false})});
 try{
  for(const item of manifest){
   const plain=decipher(keyBytes,await fs.readFile(path.join(backupDir,item.backupName)));
   await storageCall(url,key,'/object/'+encoded(temp,item.backupName),{
     method:'POST',body:plain,contentType:'application/octet-stream'});
   const restored=await storageCall(url,key,'/object/authenticated/'+encoded(temp,item.backupName));
   assert(sha(Buffer.from(await restored.arrayBuffer()))===item.sha256,'STORAGE_RESTORE_CHECKSUM_MISMATCH');
  }
 }finally{
  await storageCall(url,key,'/bucket/'+encodeURIComponent(temp)+'/empty',{method:'POST'});
  await storageCall(url,key,'/bucket/'+encodeURIComponent(temp),{method:'DELETE'});
 }
 const encrypted=cipher(keyBytes,Buffer.from(json({project:PROJECT,objects:manifest})));
 await fs.writeFile(path.join(backupDir,'storage-manifest.enc'),encrypted,{mode:0o600});
 return manifest;
}
function validateProjectOrigin(raw){
 const u=new URL(raw);
 assert(u.origin==='https://'+PROJECT+'.supabase.co','SUPABASE_URL_NOT_ALLOWLISTED');
 return u.origin;
}
function validateResetSecrets(env){
 assert(required(env,'RESET_CONFIRM')===CONFIRM,'RESET_CONFIRMATION_MISMATCH');
 const k=Buffer.from(required(env,'RESET_BACKUP_KEY_B64'),'base64');
 assert(k.length===32,'RESET_BACKUP_KEY_MUST_BE_32_BYTES');
 assert(required(env,'RESET_PROVIDER_ISOLATION_ATTESTATION')==='DISPATCH_DISABLED_AND_EXTERNAL_WEBHOOKS_ISOLATED',
  'EXTERNAL_PROVIDER_ISOLATION_NOT_ATTESTED');
 return k;
}
function pgEnv(parsed){
 const opts={...process.env,
  PGHOST:parsed.hostname,PGPORT:parsed.port||'5432',
  PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password),
  PGDATABASE:decodeURIComponent(parsed.pathname.slice(1)),PGSSLMODE:parsed.searchParams.get('sslmode')||'require'};
 return opts;
}
function validateRestoreDatabaseUrl(raw){
 const u=new URL(raw);
 assert(['postgres:','postgresql:'].includes(u.protocol),'RESTORE_DB_URL_PROTOCOL');
 assert(['127.0.0.1','localhost','::1'].includes(u.hostname),'RESTORE_DB_MUST_BE_LOCAL');
 assert(/^reset_restore_[a-f0-9]{32}$/.test(u.pathname.slice(1)),'RESTORE_DB_DISPOSABLE_NAME_REQUIRED');
 return u;
}
async function backupAndRestoreDatabase({db,url,restoreUrl,backupDir,keyBytes}){
 const parsed=new URL(url),target=validateRestoreDatabaseUrl(restoreUrl);
 assert(['postgres:','postgresql:'].includes(parsed.protocol),'DATABASE_URL_INVALID');
 assert(parsed.hostname==='db.'+PROJECT+'.supabase.co'||parsed.hostname.endsWith('.pooler.supabase.com'),
  'DATABASE_HOST_MISMATCH');
 assert(target.href!==parsed.href,'RESTORE_TARGET_MUST_DIFFER');
 const dump=path.join(backupDir,'snapshot.tmp');
 const encrypted=path.join(backupDir,'postgres.dump.enc');
 const pg={env:pgEnv(parsed),maxBuffer:1024*1024};
 const local={env:{...pgEnv(target),PGSSLMODE:target.searchParams.get('sslmode')||'disable'},maxBuffer:1024*1024};
 const dbCount=await db.query("select (select count(*)::int from public.admins) admins,(select count(*)::int from platform_private.tenants) tenants,(select count(*)::int from auth.users) users,(select count(*)::int from storage.objects) objects");
 const restored=new Client({connectionString:restoreUrl,connectionTimeoutMillis:8000});
 try{
  await exec('pg_dump',['--format=custom','--no-owner','--no-acl','--file='+dump],pg);
  const bytes=await fs.readFile(dump);
  await fs.writeFile(encrypted,cipher(keyBytes,bytes),{mode:0o600});
  const plain=decipher(keyBytes,await fs.readFile(encrypted));
  assert(sha(plain)===sha(bytes),'DATABASE_BACKUP_INTEGRITY_FAILURE');
  // Must be an already created, empty, separate local PostgreSQL 17 DB.
  // The operator never CREATEs or DROP(s) a database on Supabase, and never
  // restores to any remote server or a reused DB.
  await restored.connect();
  const state=await restored.query("select current_database() name,(select count(*)::int from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')) tables");
  assert(state.rows[0].name===target.pathname.slice(1),'RESTORE_DATABASE_NAME_MISMATCH');
  assert(state.rows[0].tables===0,'RESTORE_DATABASE_NOT_EMPTY');
  await restored.end();
  await exec('pg_restore',['--exit-on-error','--no-owner','--no-acl','--dbname='+target.pathname.slice(1),dump],local);
  const verified=new Client({connectionString:restoreUrl,connectionTimeoutMillis:8000});
  try{
   await verified.connect();
   const counts=await verified.query("select (select count(*)::int from public.admins) admins,(select count(*)::int from platform_private.tenants) tenants,(select count(*)::int from auth.users) users,(select count(*)::int from storage.objects) objects");
   assert(json(counts.rows[0])===json(dbCount.rows[0]),'RESTORED_DB_COUNTS_NOT_MATCHED');
  }finally{await verified.end().catch(()=>{})}
  return {sha256:sha(bytes),originalCounts:dbCount.rows[0],encryptedBackup:encrypted};
 }finally{
  await restored.end().catch(()=>{});
  await fs.rm(dump,{force:true}).catch(()=>{});
 }
}
async function deleteManagedResources({db,url,key,expectedObjects}){
 // This phase is deliberately non-transactional and separately observable.
 // If it fails, retain the encrypted backups and DO NOT run the SQL wipe.
 const {rows}=await db.query('select id::text from auth.users order by id');
 for(const user of rows){
  const r=await fetch(url+'/auth/v1/admin/users/'+encodeURIComponent(user.id),{
   method:'DELETE',headers:{Authorization:'Bearer '+key,apikey:key}});
  if(!r.ok)throw Error('AUTH_ADMIN_DELETE_FAILED_'+r.status);
 }
 assert((await db.query('select count(*)::int n from auth.users')).rows[0].n===0,'AUTH_RESIDUAL_ROWS');
 const buckets=[...new Set(expectedObjects.map(o=>o.bucket))];
 for(const bucket of buckets){
  await storageCall(url,key,'/bucket/'+encodeURIComponent(bucket)+'/empty',{method:'POST'});
 }
 // If a new object appears or a hidden version remains, never claim success.
 const remaining=await db.query('select count(*)::int n from storage.objects');
 assert(remaining.rows[0].n===0,'STORAGE_RESIDUAL_OBJECTS');
}
async function pauseCron(db){
 const {rows}=await db.query('select jobid,jobname from cron.job where active order by jobid');
 for(const j of rows)await db.query('select cron.alter_job($1,active:=false)',[j.jobid]);
 assert((await db.query('select count(*)::int n from cron.job where active')).rows[0].n===0,
  'ACTIVE_CRON_REMAINS');
 return rows.map(j=>j.jobname);
}
async function run(env=process.env,args=process.argv.slice(2)){
 assert(args.length===1&&['--plan','--execute'].includes(args[0]),'USE_PLAN_OR_EXECUTE');
 const conn=required(env,'RESET_DB_URL');
 const client=new Client({connectionString:conn,connectionTimeoutMillis:10000});
 await client.connect();
 try{
  assert((await client.query('select current_user as role')).rows[0].role==='postgres','DBA_ROLE_REQUIRED');
  const state=(await client.query('select maintenance.sandbox_reset_status() r')).rows[0].r;
  assert(state.projectRef===PROJECT&&state.existingProjectApprovedAsSandbox,'WRONG_PROJECT');
  const current=(await client.query('select maintenance.plan_sandbox_database_reset() p')).rows[0].p;
  if(args[0]==='--plan')return{mode:'plan',preview:current};
  const rootKey=validateResetSecrets(env);
  const url=validateProjectOrigin(required(env,'SUPABASE_URL'));
  const service=required(env,'SUPABASE_SERVICE_ROLE_KEY');
  // Attestation cannot automatically prove LINE provider-side isolation.
  const backupDir=path.resolve(required(env,'RESET_BACKUP_DIR'));
  await fs.mkdir(backupDir,{recursive:true,mode:0o700});
  assert((await fs.readdir(backupDir)).length===0,'RESET_BACKUP_DIR_MUST_BE_EMPTY');
  const backup=await backupAndRestoreDatabase({db:client,url:conn,restoreUrl:required(env,'RESET_RESTORE_DB_URL'),backupDir,keyBytes:rootKey});
  const objects=await verifyStorageArchive({url,key:service,db:client,keyBytes:rootKey,backupDir});
  await fs.writeFile(path.join(backupDir,'backup-proof.enc'),cipher(rootKey,Buffer.from(json({
   project:PROJECT,db:backup.sha256,storage:objects.length,backupAt:new Date().toISOString()
  }))),{mode:0o600});
  const paused=await pauseCron(client);
  await deleteManagedResources({db:client,url,key:service,expectedObjects:objects});
  const active=(await client.query('select count(*)::int n from cron.job where active')).rows[0].n;
  assert(active===0,'ACTIVE_DISPATCH_RESTARTED');
  await client.query("update maintenance.sandbox_reset_target set backup_verified_at=clock_timestamp(),storage_restore_verified_at=clock_timestamp(),provider_isolation_verified_at=clock_timestamp() where singleton=true");
  const plan=(await client.query('select maintenance.plan_sandbox_database_reset() p')).rows[0].p;
  const requestId=randomUUID();
  const res=await client.query('select maintenance.execute_sandbox_database_reset($1,$2,$3) as r',
   [requestId,plan.fingerprint,CONFIRM]);
  return{mode:'execute',result:res.rows[0].r,backedUpObjects:objects.length,
   pausedJobs:paused.length,encryptedBackupDirectory:backupDir,
   reminder:'Keep cron disabled until root bootstrap and outbound providers are explicitly reenabled'};
 }finally{await client.end()}
}
if(require.main===module)run().then(res=>console.log(json(res)))
 .catch(error=>{console.error('RESET_OPERATOR_FAILED:',error.message);process.exitCode=1});
module.exports={run,cipher,decipher,storageCall,encoded,validateResetSecrets,validateProjectOrigin,validateRestoreDatabaseUrl};
