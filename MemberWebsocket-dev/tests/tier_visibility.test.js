const {test}=require('node:test');const assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');const path=require('node:path');
test('tier preview separates visibility and eligibility across every tier pair',async()=>{
 const {tierVisibility}=await import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/_shared/tier-visibility.ts')));
 const tiers=['general','silver','gold','platinum'];
 for(let current=0;current<4;current++)for(let allowed=0;allowed<4;allowed++)for(const policy of ['eligible_only','higher_preview']){
  const result=tierVisibility([tiers[allowed]],tiers[current],policy);assert.equal(result.tierEligible,current===allowed);assert.equal(result.visible,current===allowed||(policy==='higher_preview'&&allowed>current));assert.equal(result.locked,current!==allowed);
 }
 for(const unknown of [null,'admin','invalid'])assert.equal(tierVisibility(['platinum'],unknown,'higher_preview').visible,false);
 assert.equal(tierVisibility(['invalid'],'general','higher_preview').visible,false);
});
