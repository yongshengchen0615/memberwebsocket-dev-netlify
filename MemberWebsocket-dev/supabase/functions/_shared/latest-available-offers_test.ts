import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { selectLatestEventOffers, selectLatestPointOffers } from "./latest-available-offers.ts";

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

Deno.test("selectLatestEventOffers only returns unused claimed or still-claimable event tickets", () => {
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
    { eventId:"event-new",title:"尚未領取",claimed:false,requiredServiceIds:[],requiredServiceMatchMode:"any" },
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
