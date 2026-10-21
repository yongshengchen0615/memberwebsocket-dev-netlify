const {Client,types}=require('pg');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
// Match PGlite's lossless timestamp strings so optimistic-lock versions are
// not rounded to milliseconds by the Node PostgreSQL driver's Date parser.
types.setTypeParser(1114,value=>value);
types.setTypeParser(1184,value=>value);
const identifier=name=>'"'+name.replaceAll('"','""')+'"';

module.exports=async()=>{
 // This harness never accepts a project URL or user-provided credentials.
 // Only the disposable service explicitly started by this CI job is usable.
 const port=Number(process.env.POSTGRES_TEST_PORT),container=process.env.POSTGRES_TEST_CONTAINER;
 if(process.env.CI!=='true'||!Number.isInteger(port)||port<1024||port>65535||!container||!/^[a-f0-9]{12,64}$/.test(container))throw Error('DISPOSABLE_POSTGRES_CI_SERVICE_REQUIRED');
 const config={host:'127.0.0.1',port,user:'postgres',password:'synthetic-ci-only',database:'postgres',connectionTimeoutMillis:5000,statement_timeout:15000};
 const admin=new Client(config);await admin.connect();
 const name='ci_booking_'+crypto.randomUUID().replaceAll('-','');
 const clients=new Set();let dump=null;
 const connect=async(database=name)=>{const c=new Client({...config,database});await c.connect();clients.add(c);return c;};
 try{
  for(const role of ['anon','authenticated','service_role','authenticator'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+identifier(role)+(role==='service_role'?' bypassrls':''));
  await admin.query('create database '+identifier(name)+' template template0');
  const client=await connect();
  const db={
   query:(sql,args)=>client.query(sql,args?.map(value=>Array.isArray(value)?JSON.stringify(value):value)),exec:sql=>client.query(sql),connect,
   name,
   async backupRestore(){
    dump='/tmp/'+name+'.dump';
    await run('docker',['exec',container,'pg_dump','-U','postgres','--format=custom','--file='+dump,name]);
    const checksum=(await run('docker',['exec',container,'sha256sum',dump])).stdout.trim().split(/\s+/)[0];
    if(!/^[a-f0-9]{64}$/.test(checksum))throw Error('BACKUP_CHECKSUM_INVALID');
    const restored=name+'_restore';await admin.query('create database '+identifier(restored)+' template template0');
    await run('docker',['exec',container,'pg_restore','-U','postgres','--exit-on-error','--no-owner','--dbname='+restored,dump]);
    return{client:await connect(restored),checksum};
   },
   async close(){
    await Promise.all([...clients].map(c=>c.end()));
    for(const database of [name+'_restore',name])await admin.query('drop database if exists '+identifier(database)+' with (force)');
    if(dump)await run('docker',['exec',container,'rm','--',dump]);
    await admin.end();
   },
  };
  return{db,rolesCreated:true};
 }catch(error){await Promise.allSettled([...clients].map(c=>c.end()));await admin.query('drop database if exists '+identifier(name)+' with (force)').catch(()=>{});await admin.end();throw error;}
};
