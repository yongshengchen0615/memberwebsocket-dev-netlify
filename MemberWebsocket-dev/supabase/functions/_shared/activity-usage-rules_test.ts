import {
  activityUsageRules, activityRequiresBooking, usageConditionLabel, bookingSatisfiesActivity, memberActivityAllowedLink,
} from "./activity-usage-rules.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(label + ": expected " + expected + ", got " + actual);
}

const item = (service_id: string, unit_price_amount: number, quantity: number) =>
  ({service_id,unit_price_amount,quantity});

Deno.test("AC-004: no booking restriction on legacy empty member event",()=>{
  const rule=activityUsageRules({});
  eq(activityRequiresBooking(rule),false,"no usage restrictions");
  eq(usageConditionLabel(rule,new Map()),"","no restrictions label");
});

Deno.test("AC-005: one confirmed booking must satisfy OR-of-AND services, selected amount and 2–4 guests",()=>{
  const rule=activityUsageRules({
    requiredServiceMatchMode:"groups",
    requiredServiceGroups:[["A","B"],["A","C"]],
    minBookingAmountMode:"selected_services",minBookingAmount:400,
    minBookingServiceIds:["B"],minBookingPartySize:2,maxBookingPartySize:4,
  });
  eq(activityRequiresBooking(rule),true,"booking required");
  const services=[item("A",100,1),item("B",200,2)];
  for(const count of [2,3,4])eq(bookingSatisfiesActivity({party_size:count},services,rule),true,"valid party "+count);
  for(const count of [1,5,0])eq(bookingSatisfiesActivity({party_size:count},services,rule),false,"invalid party "+count);
  eq(bookingSatisfiesActivity({party_size:2},[item("A",100,1),item("B",200,1)],rule),false,"selected subtotal");
  eq(bookingSatisfiesActivity({party_size:2},[item("A",100,1),item("C",200,2)],rule),false,"C not priced as selected B");
  eq(bookingSatisfiesActivity({party_size:2},[item("B",200,2)],rule),false,"B alone does not meet A+B");
});

Deno.test("AC-005 negative: service conditions cannot be assembled across two different bookings",()=>{
  const rule=activityUsageRules({requiredServiceMatchMode:"all",requiredServiceIds:["A","B"]});
  eq(bookingSatisfiesActivity({party_size:2},[item("A",100,1)],rule),false,"A separate booking");
  eq(bookingSatisfiesActivity({party_size:2},[item("B",200,1)],rule),false,"B separate booking");
  eq(bookingSatisfiesActivity({party_size:2},[item("A",100,1),item("B",200,1)],rule),true,"same booking");
});

Deno.test("AC-005: total booking amount is quantity-weighted, minimum inclusive",()=>{
  const rule=activityUsageRules({
    requiredServiceMatchMode:"any",requiredServiceIds:["A","B"],
    minBookingAmountMode:"total",minBookingAmount:500,
  });
  eq(bookingSatisfiesActivity({party_size:1},[item("A",100,1),item("B",200,2)],rule),true,"exact amount 500");
  eq(bookingSatisfiesActivity({party_size:1},[item("A",100,1),item("B",200,1)],rule),false,"under amount 300");
  eq(bookingSatisfiesActivity({party_size:1},[item("C",1000,1)],rule),false,"service any not met");
});

Deno.test("AC-005: minimum and maximum independently restrict member activity",()=>{
  const minimum=activityUsageRules({minBookingPartySize:3});
  const maximum=activityUsageRules({maxBookingPartySize:2});
  eq(bookingSatisfiesActivity({party_size:2},[],minimum),false,"under min");
  eq(bookingSatisfiesActivity({party_size:3},[],minimum),true,"meets min");
  eq(bookingSatisfiesActivity({party_size:2},[],maximum),true,"meets max");
  eq(bookingSatisfiesActivity({party_size:3},[],maximum),false,"over max");
});

Deno.test("AC-005: activity condition labels name actual services without showing IDs",()=>{
  const rule=activityUsageRules({
    requiredServiceMatchMode:"groups",
    requiredServiceGroups:[["A","B"],["A","C"]],
    minBookingAmountMode:"selected_services",minBookingAmount:400,
    minBookingServiceIds:["B"],minBookingPartySize:2,maxBookingPartySize:4,
  });
  const label=usageConditionLabel(rule,new Map([["A","肩頸"],["B","修腳"],["C","腳底"]]));
  if(!label.includes("肩頸＋修腳") || !label.includes("肩頸＋腳底")
    || !label.includes("NT$400") || !label.includes("2–4")
    || label.includes("已停用項目")) throw new Error("incomplete readable member activity condition label: "+label);
});

Deno.test("AC-SEC-001: never expose participation URL to an ineligible member", () => {
  const link = "https://example.org/member-only-activity";
  eq(memberActivityAllowedLink({linkUrl:link}, false), "", "no eligible booking");
  eq(memberActivityAllowedLink({linkUrl:link,locked:true}, true), "", "tier lock");
  eq(memberActivityAllowedLink({linkUrl:link,tierEligible:false}, true), "", "tier ineligible");
  eq(memberActivityAllowedLink({linkUrl:link}, true), link, "verified eligible member");
});
