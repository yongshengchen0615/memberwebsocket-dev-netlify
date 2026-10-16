const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const primary='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',service='20000000-0000-4000-8000-000000000001';
const store='00000000-0000-4000-8000-000000000010';
for(const slug of ['booking-group-api','booking-group-slots-api']) {
 const source=fs.readFileSync(path.join(__dirname,'../supabase/functions',slug,'index.ts'),'utf8');
 const code=stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,''));
 const normalize=vm.runInNewContext(code+'\nnormalizeGroup',{Deno:{env:{get:()=>''},serve(){}},TextEncoder,AbortSignal});
 function db(required=true,primaryId=primary) {
  const cfg={max_party_size:2,primary_technician_id:primaryId,require_primary_technician:required};
  return {from(table){
   const value=table==='booking_settings'?cfg:table==='booking_technicians'?[{id:primary,is_active:true},{id:other,is_active:true}]:[
    {id:service,is_active:true,duration_minutes:30,price_amount:100},{id:store,is_active:true,duration_minutes:10,price_amount:0}
   ];
   const q={select(){return q;},eq(){return q;},order(){return q;},in(){return q;},single(){return q;},then(resolve,reject){return Promise.resolve({data:value,error:null}).then(resolve,reject);}};return q;
  }};
 }
 const body=technicianId=>({requirePrimaryTechnician:false,participants:[{technicianId,items:[{serviceId:service,quantity:1}]}]});
 test(slug+' reads required rule from server, ignores a forged override and validates all selected technicians',async()=>{
  await assert.rejects(normalize(db(true),body(other)),{code:'BOOKING_PRIMARY_TECHNICIAN_REQUIRED'});
  await normalize(db(true),body(primary));
  await normalize(db(false),body(other));
  await normalize(db(false),body(null));
  await normalize(db(false,null),body(null));
  await normalize(db(false,null),body(other));
  await assert.rejects(normalize(db(false,null),body('10000000-0000-4000-8000-000000000099')),{code:'BOOKING_TECHNICIAN_DISABLED'});
  const p=body(other).participants[0];await assert.rejects(normalize(db(false,null),{participants:[p,p]}),{code:'DUPLICATE_PARTICIPANT_TECHNICIAN'});
  await assert.rejects(normalize(db(true,null),body(null)),{code:'BOOKING_PRIMARY_TECHNICIAN_MISSING'});
 });
}
