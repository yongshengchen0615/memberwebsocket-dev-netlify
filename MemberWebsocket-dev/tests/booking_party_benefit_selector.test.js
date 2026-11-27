const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname,'../booking/booking-benefits.js'),'utf8');
const groupSource = fs.readFileSync(path.resolve(__dirname,'../booking/group-booking.js'),'utf8');
const bookingSource = fs.readFileSync(path.resolve(__dirname,'../booking/app.js'),'utf8');

function extractFunction(name) {
  const first = source.indexOf('  function ' + name + '(');
  assert.ok(first>=0,'missing actual selector function '+name);
  let pos=source.indexOf('{',first),level=1,inSingle=false,inDouble=false,inBackticks=false,escape=false;
  for(let i=pos+1;i<source.length;i++){
    const c=source[i];
    if(escape){escape=false;continue;}
    if(c==='\\'){escape=true;continue;}
    if(inSingle){if(c==="'")inSingle=false;continue;}
    if(inDouble){if(c==='"')inDouble=false;continue;}
    if(inBackticks){if(c==='\u0060')inBackticks=false;continue;}
    if(c==="'"){inSingle=true;continue;}
    if(c==='"'){inDouble=true;continue;}
    if(c==='\u0060'){inBackticks=true;continue;}
    if(c==='{')level++;
    if(c==='}'&&!--level)return source.slice(first,i+1);
  }
  throw new Error('Unbalanced selector function '+name);
}
function predicate(partySize,services=[],amounts={}) {
 const names=['serviceIdKey','requiredServiceIds','serviceRequirementMet','amountRequirementMet','partyRequirementMet','ticketRequirementMet','ticketRequirementMessage','serviceRequirementMessage','requiredServiceTitles'];
 const code=names.map(extractFunction).join('\n');
 return new Function('currentPartySize','currentServiceIds','currentServiceAmounts',
   code+'\nreturn {ticketRequirementMet,ticketRequirementMessage,partyRequirementMet};')(
     partySize,new Set(services),new Map(Object.entries(amounts)));
}
const twoPerson={kind:'event',minBookingPartySize:2,maxBookingPartySize:3,minBookingPartySizeLabel:'每筆預約需 2–3 位',minBookingAmountMode:'none'};
test('AC-PARTY-UI-001: actual selector blocks one-person booking and matches inclusive 2/3 bounds',()=>{
 for(const [partySize,allowed] of [[1,false],[2,true],[3,true],[4,false]]){
  const p=predicate(partySize);assert.equal(p.ticketRequirementMet(twoPerson),allowed);
  if(!allowed)assert.match(p.ticketRequirementMessage(twoPerson),/預約人數不符合/);
 }
});
test('AC-PARTY-UI-002: party check combines with service and selected subtotal, no false restriction for points',()=>{
 const offer={...twoPerson,minBookingAmountMode:'total',minBookingAmount:300,requiredServiceIds:['SERVICE-A']};
 assert.equal(predicate(2,['SERVICE-A'],{'SERVICE-A':300}).ticketRequirementMet(offer),true);
 assert.equal(predicate(1,['SERVICE-A'],{'SERVICE-A':300}).ticketRequirementMet(offer),false);
 assert.equal(predicate(2,['SERVICE-A'],{'SERVICE-A':299}).ticketRequirementMet(offer),false);
 assert.equal(predicate(2,['SERVICE-B'],{'SERVICE-A':300}).ticketRequirementMet(offer),false);
 assert.equal(predicate(1).ticketRequirementMet({kind:'points',minBookingPartySize:5}),true);
});
test('AC-PARTY-UI-003: change of participant count updates selector and reconciles stale checked ticket',()=>{
 assert.match(groupSource,/BookingBenefits\?\.setServiceContext\?\.\(context, state\.partySize\)/);
 assert.match(groupSource,/partySize: \(\) => state\.partySize/);
 const start=bookingSource.indexOf('  function syncBookingBenefitContext() {');
 const end=bookingSource.indexOf('\n  function bookingBenefitServiceContext(',start);
 assert.ok(start>=0&&end>start);
 const actual=new Function('window','selectedItems','bookingBenefitServiceContext',bookingSource.slice(start,end)+'\nsyncBookingBenefitContext();');
 const primary=[{serviceId:'A',quantity:1}];const calls=[];
 actual({BookingGroupUI:{syncBenefitContext:items=>calls.push(items)}},()=>primary,()=>assert.fail('group context must own every participant'));
 assert.deepEqual(calls,[primary]);
 const single=[{serviceId:'A',amount:500}];const fallback=[];
 actual({BookingBenefits:{setServiceContext:(...args)=>fallback.push(args)}},()=>primary,()=>single);
 assert.deepEqual(fallback,[[single,1]]);
 assert.match(source,/!item \|\| item\.selectable !== true \|\| !ticketRequirementMet\(item\)/);
 assert.match(source,/if \(changed\) \{\s*emitSelectionChange\(\)/);
 assert.match(source,/const serviceBlocked = selectableKinds\.has\(item\.kind\) && !ticketRequirementMet\(item\)/);
 assert.match(source,/const parsedPartySize = Number\(partySize\)/);
});

test('AC-PARTY-UI-004: exact N is not a minimum while minimum N allows larger parties',()=>{
 const minimum={kind:'event',minBookingPartySize:2,maxBookingPartySize:0,minBookingPartySizeLabel:'每筆預約至少 2 位'};
 const exact={kind:'event',minBookingPartySize:2,maxBookingPartySize:2,minBookingPartySizeLabel:'每筆預約須剛好 2 位'};
 for(const [size,minAllowed,exactAllowed] of [[1,false,false],[2,true,true],[3,true,false]]){
   assert.equal(predicate(size).ticketRequirementMet(minimum),minAllowed);
   assert.equal(predicate(size).ticketRequirementMet(exact),exactAllowed);
 }
 assert.match(predicate(3).ticketRequirementMessage(exact),/預約人數不符合/);
});
