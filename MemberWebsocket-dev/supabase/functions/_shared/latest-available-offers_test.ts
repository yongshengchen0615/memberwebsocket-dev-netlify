import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { selectLatestEventOffers, selectLatestPointOffers } from "./latest-available-offers.ts";
import { chooseBookingPointOffers } from "./booking-point-offer-choice.ts";

Deno.test("selectLatestPointOffers uses current reward/template definitions and hides historical duplicates", () => {
  const offers = selectLatestPointOffers(
    [
      { id:"reward-a1",point_card_id:"card-1",threshold_stamps:5,ticket_template_id:"template-a1" },
      { id:"reward-a2",point_card_id:"card-1",threshold_stamps:10,ticket_template_id:"template-a2" },
    ],
    [
      { id:"card-1",title:"腳底集點卡",status:"active",style_key:"lagoon",expiry_mode:"unlimited",expires_on:null,sort_order:0 },
    ],
    [
      { id:"template-a1",title:"最新優惠 A1",status:"active" },
      { id:"template-a2",title:"最新優惠 A2",status:"active" },
    ],
    [
      { reward_id:null,point_card_id:"card-1",ticket_template_id:"template-a1",threshold_stamps:5,ticket_title:"舊優惠名稱" },
      { reward_id:"reward-a1",point_card_id:"card-1",ticket_template_id:"template-a1",threshold_stamps:5,ticket_title:"另一個舊名稱" },
      { reward_id:null,point_card_id:"card-1",ticket_template_id:"template-a2",threshold_stamps:5,ticket_title:"過期門檻版本" },
      { reward_id:"reward-a2",point_card_id:"card-1",ticket_template_id:"template-a2",threshold_stamps:10,ticket_title:"舊 A2 名稱" },
    ],
    "2026-09-15",
  );

  assertEquals(offers.map((offer) => ({
    title:offer.ticketTitle,
    threshold:offer.thresholdStamps,
    style:offer.styleKey,
  })), [
    { title:"最新優惠 A1",threshold:5,style:"lagoon" },
    { title:"最新優惠 A2",threshold:10,style:"lagoon" },
  ]);
});

Deno.test("selectLatestPointOffers ignores deleted or inactive current definitions", () => {
  const offers = selectLatestPointOffers(
    [
      { id:"reward-1",point_card_id:"card-1",threshold_stamps:5,ticket_template_id:"template-1" },
      { id:"reward-2",point_card_id:"card-2",threshold_stamps:10,ticket_template_id:"template-2" },
    ],
    [
      { id:"card-1",title:"停用卡",status:"inactive",expiry_mode:"unlimited",sort_order:0 },
      { id:"card-2",title:"有效卡",status:"active",expiry_mode:"unlimited",sort_order:1 },
    ],
    [
      { id:"template-1",title:"優惠一",status:"active" },
      { id:"template-2",title:"已停用優惠",status:"inactive" },
    ],
    [
      { reward_id:"reward-1",point_card_id:"card-1",ticket_template_id:"template-1",threshold_stamps:5 },
      { reward_id:"reward-2",point_card_id:"card-2",ticket_template_id:"template-2",threshold_stamps:10 },
    ],
    "2026-09-15",
  );
  assertEquals(offers, []);
});

Deno.test("event amount limits are published only for configured general-booking tickets", () => {
  const offers = selectLatestEventOffers([
    { id:"event-old",title:"舊票券",quota:0 },
    { id:"event-total",title:"滿額券",quota:0,min_booking_amount_mode:"total",min_booking_amount:500,min_booking_service_ids:[] },
    { id:"event-selected",title:"指定項目滿額券",quota:0,min_booking_amount_mode:"selected_services",min_booking_amount:800,min_booking_service_ids:["item-A"] },
  ],[
    {event_ticket_id:"event-old",member_id:"member-a",claim_id:"EC-OLD",status:"claimed"},
    {event_ticket_id:"event-total",member_id:"member-a",claim_id:"EC-TOTAL",status:"claimed"},
    {event_ticket_id:"event-selected",member_id:"member-a",claim_id:"EC-SELECTED",status:"claimed"},
  ],"member-a");
  assertEquals(offers[0].minBookingAmountMode,undefined);
  assertEquals(offers[1].minBookingAmountMode,"total");
  assertEquals(offers[1].minBookingAmount,500);
  assertEquals(offers[2].minBookingAmountMode,"selected_services");
  assertEquals(offers[2].minBookingAmount,800);
  assertEquals(offers[2].minBookingServiceIds,["item-A"]);
});

Deno.test("selectLatestEventOffers only returns owned, unused event tickets, never unissued inventory", () => {
  const offers = selectLatestEventOffers(
    [
      { id:"event-claimed",title:"已領取未使用",quota:10 },
      { id:"event-used",title:"已使用活動券",quota:0 },
      { id:"event-new",title:"尚未領取",quota:0 },
      { id:"event-full",title:"名額已滿",quota:1 },
      { id:"event-cancelled",title:"已取消的領券",quota:2 },
    ],
    [
      { event_ticket_id:"event-claimed",member_id:"member-1",status:"available" },
      { event_ticket_id:"event-used",member_id:"member-1",status:"used" },
      { event_ticket_id:"event-full",member_id:"member-2",status:"used" },
      { event_ticket_id:"event-cancelled",member_id:"member-1",status:"cancelled" },
    ],
    "member-1",
  );

  assertEquals(offers, [
    { eventId:"event-claimed",title:"已領取未使用",claimed:true,requiredServiceIds:[],requiredServiceMatchMode:"any" },
  ]);
});

Deno.test("event offers preserve the owned claim, GPS and current service restrictions", () => {
  const offers = selectLatestEventOffers(
    [{id:"event-a",title:"服務限定票券",quota:1,requires_location:true,
      required_service_ids:[" service-a ","service-b",""],required_service_match_mode:"all"}],
    [{event_ticket_id:"event-a",member_id:"other",claim_id:"foreign",status:"used"},
      {event_ticket_id:"event-a",member_id:"member-a",claim_id:"owned",status:"available"}],
    "member-a",
  );
  assertEquals(offers, [{eventId:"event-a",title:"服務限定票券",claimed:true,claimId:"owned",
    requiresLocation:true,requiredServiceIds:["service-a","service-b"],requiredServiceMatchMode:"all"}]);
  assertEquals(selectLatestEventOffers(
    [{id:"event-a",quota:1}],
    [{event_ticket_id:"event-a",member_id:"other",claim_id:"foreign",status:"available"}],
    "member-a",
  ), []);
});

Deno.test("unclaimed fixed and membership tickets stay hidden and cancelled claims consume quota", () => {
  const events = [{id:"fixed",fixed_ticket_template_id:"template-a",quota:0},
    {id:"referral",ticket_type:"referral",quota:0},
    {id:"join",ticket_type:"membership_join",quota:0},
    {id:"full",quota:1}];
  const claims = [{event_ticket_id:"full",member_id:"other",status:"cancelled"}];
  assertEquals(selectLatestEventOffers(events,claims,"member-a"), []);
});

Deno.test("booking expands three distinct available tickets for the same reward without multiplying notification summaries", () => {
  const rewards = [{ id: "reward-1", point_card_id: "card-1", threshold_stamps: 5, ticket_template_id: "template-1" }];
  const cards = [{ id: "card-1", title: "集點卡", status: "active", expiry_mode: "unlimited", sort_order: 0 }];
  const templates = [{ id: "template-1", title: "相同獎勵", status: "active" }];
  const tickets = ["PT-1", "PT-2", "PT-3"].map(ticket_id =>
    ({ ticket_id, reward_id: "reward-1", point_card_id: "card-1", ticket_template_id: "template-1", threshold_stamps: 5 }));
  const summaries = selectLatestPointOffers(rewards, cards, templates, tickets, "2026-10-16");
  assertEquals(summaries.length, 1);
  const booking = selectLatestPointOffers(rewards, cards, templates, tickets, "2026-10-16", true);
  assertEquals(booking.map(item => item.ticketId), ["PT-1", "PT-2", "PT-3"]);
  assertEquals(booking.every(item => item.thresholdStamps === 5), true);
});

Deno.test("one visible point reward rotates its internal ticket across bookings", () => {
  const offers = ["PT-001", "PT-002", "PT-003"].map(ticketId =>
    ({ rewardId: "reward", pointCardId: "card", ticketId }));
  const holds = [{ benefit_kind: "points", benefit_ref: "PT-001", booking_id: "first" }];
  assertEquals(chooseBookingPointOffers(offers, holds).map(row => row.ticketId), ["PT-002"]);
  assertEquals(chooseBookingPointOffers(offers, holds, "first").map(row => row.ticketId), ["PT-001"]);
  assertEquals(chooseBookingPointOffers(offers, []).length, 1);
  assertEquals(chooseBookingPointOffers(offers, [
    ...holds, { benefit_kind: "points", benefit_ref: "PT-002", booking_id: "second" },
  ]).map(row => row.ticketId), ["PT-003"]);
});

Deno.test("AC-REL-CATALOG-001: shared booking/notification catalog excludes expired claims at the exact timestamp", () => {
  const asOf = new Date("2026-11-24T00:00:00.000Z");
  const events = [
    { id:"fixed",title:"舊固定券" },
    { id:"expired",title:"相對期限到期券" },
    { id:"boundary",title:"剛好到期" },
    { id:"future",title:"尚未到期" },
    { id:"used",title:"已使用券" },
  ];
  const claims = [
    { event_ticket_id:"fixed",member_id:"member-a",claim_id:"FIX",status:"claimed",expires_at:null },
    { event_ticket_id:"expired",member_id:"member-a",claim_id:"EXP",status:"claimed",expires_at:"2026-11-23T23:59:59.999Z" },
    { event_ticket_id:"boundary",member_id:"member-a",claim_id:"EDGE",status:"claimed",expires_at:"2026-11-24T00:00:00.000Z" },
    { event_ticket_id:"future",member_id:"member-a",claim_id:"OK",status:"claimed",expires_at:"2026-11-24T00:00:00.001Z" },
    { event_ticket_id:"used",member_id:"member-a",claim_id:"USED",status:"used",expires_at:null },
  ];
  const available=selectLatestEventOffers(events,claims,"member-a",undefined,false,asOf);
  assertEquals(available.map(o=>o.claimId),["FIX","OK"]);
  const previews=selectLatestEventOffers(events,claims,"member-a",undefined,true,asOf);
  assertEquals(previews.some(o=>["expired","boundary","used"].includes(o.eventId)),false);
});

Deno.test("AC-REL-CATALOG-002: a different member's nonexpired ticket is never displayed", () => {
  const result=selectLatestEventOffers(
    [{id:"event-a",title:"活動券"}],
    [{event_ticket_id:"event-a",member_id:"member-b",claim_id:"FOREIGN",status:"claimed",expires_at:"2027-01-01T00:00:00Z"}],
    "member-a",undefined,false,new Date("2026-11-24T00:00:00Z"),
  );
  assertEquals(result,[]);
});
