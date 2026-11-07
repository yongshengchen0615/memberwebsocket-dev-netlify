import {resolveUserTestIdentity,TestModeAuthError} from './test-mode-auth.ts';
const assert=(condition:unknown,message='assertion failed')=>{if(!condition)throw Error(message);};
const db=(data:unknown,error:unknown=null)=>({from(name:string){assert(name==='test_mode_settings');return{select(){return{eq(){return{maybeSingle:async()=>({data,error})};}};}};}});
Deno.test('AC-192: inactive maintenance returns to LINE authentication, enabled maintenance denies an absent test session',async()=>{
 assert(await resolveUserTestIdentity(db({maintenance_enabled:false}),'')===null);
 let error;try{await resolveUserTestIdentity(db({maintenance_enabled:true,maintenance_message:'Synthetic maintenance'}),'');}catch(e){error=e;}
 assert(error instanceof TestModeAuthError&&error.status===503&&error.code==='SYSTEM_MAINTENANCE');
});
Deno.test('AC-192: unreadable maintenance settings fail closed and log only a bounded provider code',async()=>{
 const original=console.error,logs:unknown[][]=[];console.error=(...args)=>logs.push(args);
 try{
  for(const code of ['PGRST205','42501','sensitive\nrequest-token']){
   let error;try{await resolveUserTestIdentity(db(null,{code,message:'private DB details',details:'secret token'}),'private session token');}catch(e){error=e;}
   assert(error instanceof TestModeAuthError&&error.code==='TEST_MODE_CHECK_FAILED'&&error.status===503);
  }
  assert(JSON.stringify(logs)===JSON.stringify([
   ['TEST_MODE_SETTINGS_READ_FAILED',{code:'PGRST205'}],
   ['TEST_MODE_SETTINGS_READ_FAILED',{code:'42501'}],
   ['TEST_MODE_SETTINGS_READ_FAILED',{code:'UNKNOWN'}],
  ]),'no provider message, token or actor belongs in this diagnostic');
 }finally{console.error=original;}
});
