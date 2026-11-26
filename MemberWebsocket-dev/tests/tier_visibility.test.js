const {test}=require('node:test');const assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');const path=require('node:path');
test('tier preview separates visibility and eligibility across every tier pair',async()=>{
 const {tierVisibility}=await import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/_shared/tier-visibility.ts')));
 const tiers=['general','silver','gold','platinum'];
 for(let current=0;current<4;current++)for(let allowed=0;allowed<4;allowed++)for(const policy of ['eligible_only','higher_preview']){
  const result=tierVisibility([tiers[allowed]],tiers[current],policy);assert.equal(result.tierEligible,current>=allowed);assert.equal(result.visible,current>=allowed||(policy==='higher_preview'&&allowed>current));assert.equal(result.locked,current<allowed);
 }
 for(const unknown of [null,'admin','invalid'])assert.equal(tierVisibility(['platinum'],unknown,'higher_preview').visible,false);
 assert.equal(tierVisibility(['invalid'],'general','higher_preview').visible,false);
 assert.equal(tierVisibility(['silver','platinum'],'gold','eligible_only').tierEligible,true);
 assert.equal(tierVisibility(['silver'],'general','eligible_only').locked,true);
});


test('calendar activity and ticket-linked event inheritance rejects lower tiers',async()=>{
 const {isEligibleTierActivity}=await import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/_shared/activity-eligibility.ts')));
 const tiers=['general','silver','gold','platinum'];
 for(let current=0;current<4;current++)for(let minimum=0;minimum<4;minimum++){
   const required=tiers[minimum],eligible=current>=minimum;
   const event={item_type:'event',status:'active',allowed_tier_keys:[required],starts_on:'2026-11-01',ends_on:'2026-12-31'};
   assert.equal(isEligibleTierActivity(event,tiers[current],'2026-11-26',null,new Map(),new Map(),true),eligible,
     `calendar ${tiers[current]} vs ${required}`);
   event.source_event_ticket_id='source-ticket';
   const sources=new Map([['source-ticket',{status:'active',allowed_tier_keys:[required],starts_on:'2026-11-01',ends_on:'2026-12-31',quota:0}]]);
   assert.equal(isEligibleTierActivity(event,tiers[current],'2026-11-26',null,sources,new Map(),true),eligible,
     `linked ticket ${tiers[current]} vs ${required}`);
 }
});
