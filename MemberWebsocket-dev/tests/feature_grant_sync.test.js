const {test}=require('node:test'),assert=require('node:assert/strict');
const error=(status,code,message)=>Object.assign(Error(message),{status,code});
function fixture(){
 const features={membership:true,points:true,events:true,calendar:true,booking:true};
 let active=true,reads=0;
 const db={businessFeatures:features,from(table){reads++;const q={select(){return q;},eq(){return q;},in(){return q;},not(field,operator,pattern){assert.equal(field,'event_type');assert.equal(operator,'like');assert.equal(pattern,'%.presence.%');return q;},order(){return q;},limit(){return q;},async maybeSingle(){return {data:table==='admins'?{role:'admin',status:active?'active':'disabled'}:{id:42,created_at:'2026-11-06T00:00:00Z'},error:null};}};return q;}};
 return {db,features,get reads(){return reads;},disable(){active=false;}};
}
test('AC-SYNC-001: every grant revoke/re-enable changes the authenticated revision without a business event',async()=>{
 const {syncRevision}=await import('../supabase/functions/_shared/sync-revision.mjs'),h=fixture();
 const before=await syncRevision(h.db,'admin','synthetic-admin',error);
 for(const key of ['membership','points','events','calendar','booking']){
  h.features[key]=false;
  const off=await syncRevision(h.db,'admin','synthetic-admin',error);
  assert.notEqual(off.revision,before.revision,key+' revocation must invalidate an already-open page');
  h.features[key]=true;
  assert.deepEqual(await syncRevision(h.db,'admin','synthetic-admin',error),before);
 }
 assert.equal(h.reads,22,'each probe retains the existing two database reads');
 assert.deepEqual(Object.keys(before),['revision']);assert.ok(before.revision.length<=120);
});
test('AC-SYNC-002: stable or reordered grants stay idle; untrusted truthy values never grant a feature',async()=>{
 const {syncRevision}=await import('../supabase/functions/_shared/sync-revision.mjs'),h=fixture();
 const on=await syncRevision(h.db,'admin','synthetic-admin',error);
 h.db.businessFeatures=Object.fromEntries(Object.entries(h.features).reverse());
 assert.deepEqual(await syncRevision(h.db,'admin','synthetic-admin',error),on);
 h.db.businessFeatures.points=false;const off=await syncRevision(h.db,'admin','synthetic-admin',error);
 h.db.businessFeatures.points='true';assert.deepEqual(await syncRevision(h.db,'admin','synthetic-admin',error),off);
 h.disable();await assert.rejects(syncRevision(h.db,'admin','synthetic-admin',error),e=>e.code==='ADMIN_REQUIRED');
});
