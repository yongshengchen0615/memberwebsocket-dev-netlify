const {test}=require('node:test');const assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');const path=require('node:path');
test('delegated completion notification separates normal recipient rewards from actor bonuses',async()=>{
 const {completionSummary}=await import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/booking-line-notifications/completion-summary.ts')));
 const normal={service_minutes:60,reward_details:[{pointCardTitle:'Body',points:2}]};
 assert.match(completionSummary(normal,null),/獲得集點：Body \+2 點/);
 const delegated=completionSummary(normal,{service_minutes:30,reward_details:[{pointCardTitle:'Body',points:1}]});
 assert.match(delegated,/好友正常服務已結算：60 分鐘/);assert.match(delegated,/您的代約獎勵時間：30 分鐘/);assert.match(delegated,/您的代約獎勵集點：Body \+1 點/);assert.doesNotMatch(delegated,/獲得集點：Body \+2/);
});
